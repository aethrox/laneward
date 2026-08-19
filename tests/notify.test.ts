import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db";
import {
  createNotifier,
  notificationClassNames,
  notificationClasses,
  notificationCommand,
  renderNotification,
} from "../src/notify";

beforeEach(async () => {
  await sql`TRUNCATE notifications, lanes, messages, approvals, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function lane(status: "pending" | "waiting_approval" | "failed" | "completed", brief = "brief") {
  const laneId = `lane-${crypto.randomUUID()}`;
  await sql`
    INSERT INTO lanes (lane_id, owned_paths, lane_type, status, worktree_path, original_brief)
    VALUES (${laneId}, ${sql.array(["src/notify.ts"], "text")}, 'write', ${status}, 'C:/worktree', ${brief})
  `;
  return laneId;
}

function testNotifier(classes: string[] = ["approval_required", "lane_failed"], exitCode = 0) {
  const commands: string[][] = [];
  const logs: string[] = [];
  return {
    commands,
    logs,
    notifier: createNotifier({
      classes: notificationClasses(classes.join(",")),
      dashboardUrl: "http://127.0.0.1:8787",
      platform: "linux",
      spawn: async (command) => {
        commands.push(command);
        return exitCode;
      },
      log: (line) => logs.push(line),
    }),
  };
}

test("a waiting approval notifies once until the lane leaves that state", async () => {
  const laneId = await lane("waiting_approval");
  const { commands, logs, notifier } = testNotifier();

  await notifier.poll();
  await notifier.poll();

  expect(commands).toHaveLength(1);
  expect(commands[0][0]).toBe("notify-send");
  expect(commands[0].join(" ")).toContain(laneId);
  const stored = await sql`SELECT delivered_at FROM notifications`;
  expect(stored).toHaveLength(1);
  expect(stored[0].delivered_at).not.toBeNull();
  expect(logs).toEqual(["desktop notification sent: approval_required"]);
});

test("a lane that fails again after reset notifies again", async () => {
  const laneId = await lane("failed");
  const { commands, notifier } = testNotifier();

  await notifier.poll();
  await sql`UPDATE lanes SET status = 'pending' WHERE lane_id = ${laneId}`;
  await notifier.poll();
  await sql`UPDATE lanes SET status = 'failed' WHERE lane_id = ${laneId}`;
  await notifier.poll();

  expect(commands).toHaveLength(2);
  const sent = await sql`SELECT occurrence, cleared_at FROM notifications ORDER BY occurrence`;
  expect(sent.map((row: any) => row.occurrence)).toEqual([1, 2]);
  expect(sent[0].cleared_at).not.toBeNull();
  expect(sent[1].cleared_at).toBeNull();
});

test("an event class outside the enabled list never notifies", async () => {
  await lane("waiting_approval");
  const { commands, notifier } = testNotifier(["lane_failed"]);

  await notifier.poll();

  expect(commands).toEqual([]);
});

test("a plan notifies when all of its bound lanes are ready for review", async () => {
  const laneId = await lane("completed");
  await sql`INSERT INTO plans (plan_id, title) VALUES ('plan-ready', 'Plan Ready')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('plan-ready', 1, ${{ objective: "test" }})
    RETURNING id
  `;
  await sql`UPDATE lanes SET plan_revision_id = ${revision.id} WHERE lane_id = ${laneId}`;
  const { commands, notifier } = testNotifier(["plan_ready_for_review"]);

  await notifier.poll();

  expect(commands).toHaveLength(1);
  expect(commands[0].join(" ")).toContain("Plan Ready");
  expect(commands[0].join(" ")).toContain("All lanes are ready for review. Open http://127.0.0.1:8787.");
});

test("a plan-revision approval reuses the approval_required notification", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('candidate-plan', 'Candidate Plan')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('candidate-plan', 1, ${{ objective: "test" }}) RETURNING id
  `;
  await sql`
    INSERT INTO approvals (subject_kind, plan_revision_id)
    VALUES ('plan_revision', ${revision.id})
  `;
  const { commands, notifier } = testNotifier(["approval_required"]);

  await notifier.poll();

  expect(commands).toHaveLength(1);
  expect(commands[0].join(" ")).toContain("Candidate Plan");
  expect(commands[0].join(" ")).toContain("Approval is required.");
});

test("open reader findings notify their revision until adjudicated, then raise a new occurrence", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('reader-plan', 'Reader Plan')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('reader-plan', 1, ${{ objective: "test" }}) RETURNING id
  `;
  const [run] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    VALUES (${revision.id}, 'reader', 1, 'succeeded') RETURNING id
  `;
  const [finding] = await sql`
    INSERT INTO verification_findings (verification_run_id, finding, subject)
    VALUES (${run.id}, 'Reader concern', 'test_diff') RETURNING id
  `;
  const { commands, notifier } = testNotifier(["findings_to_adjudicate"]);

  await notifier.poll();
  expect(commands).toHaveLength(1);
  const [sent] = await sql`SELECT subject_kind, occurrence FROM notifications`;
  expect(sent.subject_kind).toBe("plan_revision");
  expect(sent.occurrence).toBe(1);

  await sql`UPDATE verification_findings SET state = 'accepted' WHERE id = ${finding.id}`;
  await notifier.poll();
  await sql`
    INSERT INTO verification_findings (verification_run_id, finding, subject)
    VALUES (${run.id}, 'New reader concern', 'source_context')
  `;
  await notifier.poll();

  expect(commands).toHaveLength(2);
  const sentAgain = await sql`SELECT occurrence, cleared_at FROM notifications ORDER BY occurrence`;
  expect(sentAgain.map((row: any) => row.occurrence)).toEqual([1, 2]);
  expect(sentAgain[0].cleared_at).not.toBeNull();
  expect(sentAgain[1].cleared_at).toBeNull();
});

test("reader findings require a succeeded newest reader run", async () => {
  for (const status of ["failed", "skipped"] as const) {
    await sql`INSERT INTO plans (plan_id, title) VALUES (${`reader-${status}`}, 'Reader Plan')`;
    const [revision] = await sql`
      INSERT INTO plan_revisions (plan_id, revision, content)
      VALUES (${`reader-${status}`}, 1, ${{ objective: "test" }}) RETURNING id
    `;
    const [run] = await sql`
      INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
      VALUES (${revision.id}, 'reader', 1, ${status}) RETURNING id
    `;
    await sql`
      INSERT INTO verification_findings (verification_run_id, finding, subject)
      VALUES (${run.id}, 'Reader concern', 'test_diff')
    `;
  }
  const { commands, notifier } = testNotifier(["findings_to_adjudicate"]);

  await notifier.poll();

  expect(commands).toEqual([]);
});

test("an empty LANEWARD_NOTIFY enables no classes", async () => {
  await lane("waiting_approval");
  const commands: string[][] = [];
  const disabled = createNotifier({
    classes: notificationClasses(""),
    dashboardUrl: "http://127.0.0.1:8787",
    platform: "linux",
    spawn: async (command) => (commands.push(command), 0),
  });

  await disabled.poll();

  expect(commands).toEqual([]);
  expect(notificationClasses(undefined)).toEqual(new Set(["approval_required", "lane_failed"]));
});

test("an unknown LANEWARD_NOTIFY class fails startup configuration by name", () => {
  expect(notificationClasses("findings_to_adjudicate")).toEqual(new Set(["findings_to_adjudicate"]));
  expect(() => notificationClasses("approval_required,not-a-class")).toThrow("not-a-class");
});

test("notification subject kinds reject unknown values", async () => {
  // Caught rather than asserted with .rejects: a bun SQL query is a lazy
  // thenable, and expect(...).rejects never settles on one, which hangs the
  // whole file. tests/routes.findings.test.ts asserts a CHECK the same way.
  let error: unknown;
  try {
    await sql`
      INSERT INTO notifications (subject_kind, subject_id, event_class, occurrence)
      VALUES ('unknown', 'subject', 'findings_to_adjudicate', 1)
    `;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
});

test("rendered text never includes a lane brief or evidence", async () => {
  const secret = "SECRET-DO-NOT-NOTIFY";
  const laneId = await lane("waiting_approval", secret);
  await sql`
    INSERT INTO messages (lane_id, message_type, evidence_refs)
    VALUES (${laneId}, 'EVIDENCE', ${{ secret }})
  `;

  for (const eventClass of notificationClassNames) {
    const rendered = renderNotification(eventClass, laneId, "http://127.0.0.1:8787");
    expect(`${rendered.title} ${rendered.body}`).not.toContain(secret);
  }
});

test("a failed delivery leaves delivered_at NULL, keeps the row, and is not retried", async () => {
  const laneId = await lane("failed");
  const { commands, notifier } = testNotifier(["lane_failed"], 1);

  await notifier.poll();
  await notifier.poll();

  expect(commands).toHaveLength(1);
  const [stored] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`;
  expect(stored.status).toBe("failed");
  const [notification] = await sql`SELECT delivered_at FROM notifications`;
  expect(notification.delivered_at).toBeNull();
});

test("a missing platform command is logged and does not affect the lane", async () => {
  const laneId = await lane("failed");
  const log: string[] = [];
  const missing = createNotifier({
    classes: notificationClasses("lane_failed"),
    dashboardUrl: "http://127.0.0.1:8787",
    platform: "darwin",
    log: (line) => log.push(line),
  });

  await missing.poll();

  expect(log).toEqual(["desktop notification unavailable on darwin"]);
  expect((await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`)[0].status).toBe("failed");
  const [notification] = await sql`SELECT delivered_at FROM notifications`;
  expect(notification.delivered_at).toBeNull();
});

test("a missing delivery executable is non-fatal", async () => {
  const laneId = await lane("failed");
  const log: string[] = [];
  const missing = createNotifier({
    classes: notificationClasses("lane_failed"),
    dashboardUrl: "http://127.0.0.1:8787",
    platform: "linux",
    spawn: async () => { throw new Error("notify-send missing"); },
    log: (line) => log.push(line),
  });

  await missing.poll();

  expect(log).toEqual(["desktop notification failed: Error: notify-send missing"]);
  expect((await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`)[0].status).toBe("failed");
  const [notification] = await sql`SELECT delivered_at FROM notifications`;
  expect(notification.delivered_at).toBeNull();
});

test("Linux and Windows commands keep spaced quoted text in an argument array", () => {
  const title = 'Plan "one" title';
  const body = 'Reason "two" with spaces';
  const linux = notificationCommand("linux", title, body, "critical")!;
  const windows = notificationCommand("win32", title, body, "critical")!;

  expect(linux).toEqual(["notify-send", "-u", "critical", title, body]);
  expect(windows[0]).toEndWith("\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(windows.slice(1, 4)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(windows[4], "base64").toString("utf16le");
  expect(script).toContain(`'${title}'`);
  expect(script).toContain(`'${body}'`);
  expect(notificationCommand("darwin", title, body, "critical")).toBeNull();
});

test("a Windows toast never lets subject text escape into PowerShell", () => {
  const hostile = "$(Write-Output pwned)`whoami` 'quoted'";
  const windows = notificationCommand("win32", hostile, hostile, "critical")!;
  const script = Buffer.from(windows[4], "base64").toString("utf16le");

  // Doubled quotes keep it one literal; nothing reopens an interpolating string.
  expect(script).toContain("'$(Write-Output pwned)`whoami` ''quoted'''");
  expect(script).not.toContain('"');
});
