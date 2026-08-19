import { sql } from "./db";

export const notificationClassNames = [
  "approval_required",
  "lane_failed",
  "plan_ready_for_review",
  "findings_to_adjudicate",
] as const;

export type NotificationClass = (typeof notificationClassNames)[number];
type Urgency = "normal" | "critical";

const notifications: Record<NotificationClass, { reason: string; urgency: Urgency }> = {
  approval_required: { reason: "Approval is required.", urgency: "critical" },
  lane_failed: { reason: "A lane failed and needs attention.", urgency: "critical" },
  plan_ready_for_review: { reason: "All lanes are ready for review.", urgency: "normal" },
  findings_to_adjudicate: { reason: "Reader findings need adjudication.", urgency: "normal" },
};

export function notificationClasses(value: string | undefined): Set<NotificationClass> {
  if (value === undefined) return new Set(["approval_required", "lane_failed"]);
  if (value === "") return new Set();

  return new Set(value.split(",").map((name) => {
    const candidate = name.trim();
    if (!(notificationClassNames as readonly string[]).includes(candidate)) {
      throw new Error(`invalid LANEWARD_NOTIFY class: ${candidate}`);
    }
    return candidate as NotificationClass;
  }));
}

export function renderNotification(
  eventClass: NotificationClass,
  subject: string,
  dashboardUrl: string,
): { title: string; body: string; urgency: Urgency } {
  const event = notifications[eventClass];
  return {
    title: `Laneward - ${event.urgency} - ${subject}`,
    body: `${event.reason} Open ${dashboardUrl}.`,
    urgency: event.urgency,
  };
}

// A PowerShell single-quoted literal interpolates nothing, so $(...) and ` in
// free text stay text. Doubling ' is the only escape it has.
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsCommand(title: string, body: string): string[] {
  const script = [
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$text = $xml.GetElementsByTagName('text')",
    `$text.Item(0).AppendChild($xml.CreateTextNode(${psLiteral(title)})) | Out-Null`,
    `$text.Item(1).AppendChild($xml.CreateTextNode(${psLiteral(body)})) | Out-Null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Laneward').Show($toast)",
  ].join(";");
  // Windows PowerShell is not on PATH for every parent process, a git-bash shell
  // among them, so the interpreter is addressed by its fixed location.
  const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return [powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export function notificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  urgency: Urgency,
): string[] | null {
  if (platform === "linux") return ["notify-send", "-u", urgency, title, body];
  if (platform === "win32") return windowsCommand(title, body);
  return null;
}

type Candidate = {
  event_class: NotificationClass;
  subject_kind: "lane" | "plan" | "plan_revision";
  subject_id: string;
  subject: string;
};

export type NotifierOptions = {
  classes: ReadonlySet<NotificationClass>;
  dashboardUrl: string;
  platform?: NodeJS.Platform;
  spawn?: (command: string[]) => Promise<number>;
  log?: (line: string) => void;
};

export function createNotifier(options: NotifierOptions) {
  const platform = options.platform ?? process.platform;
  const spawn: (command: string[]) => Promise<number> =
    options.spawn ?? (async (command: string[]) => Bun.spawn(command).exited);
  const log = options.log ?? console.error;
  let polling = false;

  async function candidates(): Promise<Candidate[]> {
    const rows = await sql`
      SELECT 'approval_required'::text AS event_class, 'lane'::text AS subject_kind,
             l.lane_id AS subject_id, COALESCE(p.title, l.lane_id) AS subject
      FROM lanes l
      LEFT JOIN plan_revisions r ON r.id = l.plan_revision_id
      LEFT JOIN plans p ON p.plan_id = r.plan_id
      WHERE l.status = 'waiting_approval'
      UNION ALL
      SELECT 'approval_required', 'plan', r.id::text, p.title
      FROM approvals a
      JOIN plan_revisions r ON r.id = a.plan_revision_id
      JOIN plans p ON p.plan_id = r.plan_id
      WHERE a.subject_kind = 'plan_revision' AND a.resolved_at IS NULL
      UNION ALL
      SELECT 'lane_failed', 'lane', l.lane_id, COALESCE(p.title, l.lane_id)
      FROM lanes l
      LEFT JOIN plan_revisions r ON r.id = l.plan_revision_id
      LEFT JOIN plans p ON p.plan_id = r.plan_id
      WHERE l.status = 'failed'
      UNION ALL
      SELECT 'plan_ready_for_review', 'plan', r.id::text, p.title
      FROM plans p
      JOIN plan_revisions r ON r.plan_id = p.plan_id
      JOIN lanes l ON l.plan_revision_id = r.id
      GROUP BY r.id, p.title
      HAVING bool_and(l.status = 'completed')
      UNION ALL
      SELECT 'findings_to_adjudicate', 'plan_revision', r.id::text, p.title
      FROM plans p
      JOIN plan_revisions r ON r.plan_id = p.plan_id
      JOIN LATERAL (
        SELECT status FROM verification_runs
        WHERE plan_revision_id = r.id AND layer = 'reader'
        ORDER BY attempt DESC LIMIT 1
      ) reader ON reader.status = 'succeeded'
      WHERE EXISTS (
        SELECT 1 FROM verification_findings f
        JOIN verification_runs v ON v.id = f.verification_run_id
        WHERE v.plan_revision_id = r.id AND f.state = 'open'
      )
    `;
    return rows.filter((row: Candidate) => options.classes.has(row.event_class));
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const current = await candidates();
      const active = new Set(current.map((event) => `${event.event_class}:${event.subject_kind}:${event.subject_id}`));
      const sent = await sql`
        SELECT id, event_class, subject_kind, subject_id
        FROM notifications WHERE cleared_at IS NULL
      `;
      for (const row of sent) {
        if (!active.has(`${row.event_class}:${row.subject_kind}:${row.subject_id}`)) {
          await sql`UPDATE notifications SET cleared_at = now() WHERE id = ${row.id}`;
        }
      }

      for (const event of current) {
        const [existing] = await sql`
          SELECT id FROM notifications
          WHERE event_class = ${event.event_class} AND subject_kind = ${event.subject_kind}
            AND subject_id = ${event.subject_id} AND cleared_at IS NULL
        `;
        if (existing) continue;

        const [notification] = await sql`
          INSERT INTO notifications (subject_kind, subject_id, event_class, occurrence)
          SELECT ${event.subject_kind}, ${event.subject_id}, ${event.event_class},
                 COALESCE(MAX(occurrence), 0) + 1
          FROM notifications
          WHERE subject_kind = ${event.subject_kind} AND subject_id = ${event.subject_id}
            AND event_class = ${event.event_class}
          RETURNING id
        `;

        const rendered = renderNotification(event.event_class, event.subject, options.dashboardUrl);
        const command = notificationCommand(platform, rendered.title, rendered.body, rendered.urgency);
        if (!command) {
          log(`desktop notification unavailable on ${platform}`);
          continue;
        }
        try {
          if (await spawn(command)) log(`desktop notification failed: ${event.event_class}`);
          else {
            await sql`UPDATE notifications SET delivered_at = now() WHERE id = ${notification.id}`;
            log(`desktop notification sent: ${event.event_class}`);
          }
        } catch (error) {
          log(`desktop notification failed: ${error}`);
        }
      }
    } finally {
      polling = false;
    }
  }

  return { poll };
}

export function startNotifier(options: NotifierOptions & { pollMs?: number }) {
  const notifier = createNotifier(options);
  void notifier.poll().catch((error) => (options.log ?? console.error)(`desktop notification poll failed: ${error}`));
  setInterval(() => void notifier.poll().catch((error) => (options.log ?? console.error)(`desktop notification poll failed: ${error}`)), options.pollMs ?? 1_000);
  return notifier;
}
