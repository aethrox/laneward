import { join } from "node:path";
import { sql } from "./db";
import { defaultLogDir } from "./paths";
import type { LaneStatus, LaneType } from "./types";

export interface DashboardConfig {
  logDir: string;
  pollMs: number;
  picoPath: string;
}

export function defaultConfig(): DashboardConfig {
  return {
    logDir: defaultLogDir(),
    pollMs: 1000,
    picoPath: join(import.meta.dir, "..", "assets", "pico.classless.min.css"),
  };
}

export function logPath(cfg: DashboardConfig, laneId: string): string {
  return join(cfg.logDir, `${laneId}.log`);
}

// Reading the tail by bytes can cut the first line in half; drop it rather than
// showing the operator half a sentence.
export async function readTail(path: string, maxLines = 40) {
  const file = Bun.file(path);
  if (!(await file.exists())) return { text: "", next: 0 };
  const size = file.size;
  const start = Math.max(0, size - 64 * 1024);
  let text = await file.slice(start).text();
  if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  return { text: text.trimEnd().split("\n").slice(-maxLines).join("\n"), next: size };
}

// The conductor blanks a lane's log before each dispatch, so a shrinking file is
// a new run, not corruption: rewind and tell the caller to replace what it shows.
export async function readFrom(path: string, offset: number) {
  const file = Bun.file(path);
  if (!(await file.exists())) return { chunk: "", next: 0, reset: offset > 0 };
  const size = file.size;
  if (size < offset) {
    return { chunk: await file.text(), next: size, reset: true };
  }
  if (size === offset) return { chunk: "", next: size, reset: false };
  return { chunk: await file.slice(offset).text(), next: size, reset: false };
}

export interface LaneSnapshot {
  lane_id: string;
  status: LaneStatus;
  lane_type: LaneType;
  owned_paths: string[];
  worktree_path: string;
  attempt_count: number;
  last_message_at: string | null;
  last_message_type: string | null;
  approval_id: string | null;
  pending_question: string | null;
  plan_revision_id: string | null;
  evidence: EvidenceSnapshot[];
  approvals: ApprovalSnapshot[];
  log_bytes: number;
}

export interface EvidenceSnapshot {
  id: number;
  created_at: string;
  evidence_refs: unknown;
}

export interface ApprovalSnapshot {
  id: string;
  requested_at: string;
  resolved_at: string | null;
  decision: string | null;
  resolved_by: string | null;
  verified_by: string | null;
}

export interface PlanRevisionSnapshot {
  id: string;
  revision: number;
  approved: boolean;
  approved_at: string | null;
  approved_by: string | null;
  is_newest: boolean;
  approval_id: string | null;
  pending_question: string | null;
  construction: VerificationRunSnapshot | null;
  clean_run: (VerificationRunSnapshot & { unmet_expectations: string[] }) | null;
  reader: VerificationRunSnapshot | null;
  findings: FindingSnapshot[];
}

export interface VerificationRunSnapshot {
  status: "running" | "succeeded" | "failed" | "skipped" | "no_findings";
  attempt: number;
}

export interface FindingSnapshot {
  finding: string;
  subject: "test_diff" | "source_context";
  locations: unknown;
}

export interface PlanSnapshot {
  plan_id: string;
  title: string;
  revisions: PlanRevisionSnapshot[];
}

const iso = (value: Date | string | null) => value instanceof Date ? value.toISOString() : value;

// `lanes` has no timestamps, so "when did this last move" comes from the newest
// message. The approval question is looked up separately from the newest
// message because the newest message is often not the APPROVAL_REQUEST.
export async function snapshot(cfg: DashboardConfig): Promise<LaneSnapshot[]> {
  const rows = await sql`
    SELECT l.lane_id, l.status, l.lane_type, l.owned_paths, l.worktree_path,
           l.attempt_count,
           m.created_at AS last_message_at, m.message_type AS last_message_type,
           a.id AS approval_id, q.question AS pending_question,
           l.plan_revision_id
    FROM lanes l
    LEFT JOIN LATERAL (
      SELECT created_at, message_type FROM messages
      WHERE lane_id = l.lane_id ORDER BY created_at DESC, id DESC LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT id FROM approvals
      WHERE lane_id = l.lane_id AND resolved_at IS NULL
      ORDER BY requested_at DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT question FROM messages
      WHERE lane_id = l.lane_id AND message_type = 'APPROVAL_REQUEST'
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) q ON true
    ORDER BY m.created_at DESC NULLS LAST, l.lane_id
  `;

  const laneIds = rows.map((row: any) => row.lane_id);
  const [evidenceRows, approvalRows] = await Promise.all([
    sql`
      SELECT id, lane_id, created_at, evidence_refs
      FROM (
        SELECT id, lane_id, created_at, evidence_refs,
               row_number() OVER (PARTITION BY lane_id ORDER BY created_at DESC, id DESC) AS rank
        FROM messages
        WHERE lane_id = ANY(${sql.array(laneIds, "text")}) AND message_type = 'EVIDENCE'
      ) evidence
      WHERE rank <= 10
      ORDER BY lane_id, created_at DESC, id DESC
    `,
    sql`
      SELECT id, lane_id, requested_at, resolved_at, decision, resolved_by, verified_by
      FROM approvals
      WHERE lane_id = ANY(${sql.array(laneIds, "text")})
      ORDER BY lane_id, requested_at DESC, id DESC
    `,
  ]);
  const evidence = new Map<string, EvidenceSnapshot[]>();
  const approvals = new Map<string, ApprovalSnapshot[]>();
  for (const row of evidenceRows as any[]) {
    const entries = evidence.get(row.lane_id) ?? [];
    entries.push({ ...row, created_at: iso(row.created_at)! });
    evidence.set(row.lane_id, entries);
  }
  for (const row of approvalRows as any[]) {
    const entries = approvals.get(row.lane_id) ?? [];
    entries.push({
      ...row,
      requested_at: iso(row.requested_at)!,
      resolved_at: iso(row.resolved_at),
    });
    approvals.set(row.lane_id, entries);
  }

  return rows.map((row: any) => ({
    ...row,
    last_message_at: iso(row.last_message_at),
    evidence: evidence.get(row.lane_id) ?? [],
    approvals: approvals.get(row.lane_id) ?? [],
    log_bytes: Bun.file(logPath(cfg, row.lane_id)).size,
  }));
}

export async function planSnapshot(): Promise<PlanSnapshot[]> {
  // Keep the construction-failure sentence below in sync with GET /pending in app.ts.
  const rows = await sql`
    SELECT p.plan_id, p.title, r.id, r.revision, r.approved_at, r.approved_by,
           r.revision = MAX(r.revision) OVER (PARTITION BY p.plan_id) AS is_newest,
           a.id AS approval_id,
           construction.status AS construction_status,
           construction.attempt AS construction_attempt,
           clean_run.status AS clean_run_status,
           clean_run.attempt AS clean_run_attempt,
           clean_run.detail AS clean_run_detail,
           reader.status AS reader_status,
           reader.attempt AS reader_attempt,
           CASE WHEN a.id IS NULL THEN NULL ELSE COALESCE(
             'Candidate construction failed during ' || (construction.detail->>'step') || ': ' || (construction.detail->>'message'),
             'Candidate construction failed and needs attention.'
           ) END AS pending_question
    FROM plans p
    LEFT JOIN plan_revisions r ON r.plan_id = p.plan_id
    LEFT JOIN LATERAL (
      SELECT id FROM approvals
      WHERE subject_kind = 'plan_revision'
        AND plan_revision_id = r.id AND resolved_at IS NULL
      ORDER BY requested_at DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT status, attempt, detail FROM verification_runs
      WHERE plan_revision_id = r.id AND layer = 'construction'
      ORDER BY attempt DESC LIMIT 1
    ) construction ON true
    LEFT JOIN LATERAL (
      SELECT status, attempt, detail FROM verification_runs
      WHERE plan_revision_id = r.id AND layer = 'clean_run'
      ORDER BY attempt DESC LIMIT 1
    ) clean_run ON true
    LEFT JOIN LATERAL (
      SELECT status, attempt FROM verification_runs
      WHERE plan_revision_id = r.id AND layer = 'reader'
      ORDER BY attempt DESC LIMIT 1
    ) reader ON true
    ORDER BY p.plan_id, r.revision DESC NULLS LAST
  `;
  const revisionIds = rows.map((row: any) => row.id).filter(Boolean);
  const findingRows = await sql`
    SELECT v.plan_revision_id, f.finding, f.subject, f.locations
    FROM verification_findings f
    JOIN verification_runs v ON v.id = f.verification_run_id
    WHERE v.plan_revision_id = ANY(${sql.array(revisionIds, "uuid")}) AND f.state = 'open'
    ORDER BY v.plan_revision_id, f.raised_at DESC, f.id DESC
  `;
  const findings = new Map<string, FindingSnapshot[]>();
  for (const row of findingRows as any[]) {
    const entries = findings.get(row.plan_revision_id) ?? [];
    entries.push({ finding: row.finding, subject: row.subject, locations: row.locations });
    findings.set(row.plan_revision_id, entries);
  }
  const plans = new Map<string, PlanSnapshot>();
  for (const row of rows as any[]) {
    let plan = plans.get(row.plan_id);
    if (!plan) {
      plan = { plan_id: row.plan_id, title: row.title, revisions: [] };
      plans.set(row.plan_id, plan);
    }
    if (row.id) {
      plan.revisions.push({
        id: row.id,
        revision: row.revision,
        approved: Boolean(row.approved_at),
        approved_at: iso(row.approved_at),
        approved_by: row.approved_by,
        is_newest: row.is_newest,
        approval_id: row.approval_id,
        pending_question: row.pending_question,
        construction: row.construction_status
          ? { status: row.construction_status, attempt: row.construction_attempt }
          : null,
        clean_run: row.clean_run_status
          ? {
              status: row.clean_run_status,
              attempt: row.clean_run_attempt,
              unmet_expectations: Array.isArray(row.clean_run_detail?.expectations)
                ? row.clean_run_detail.expectations
                    .filter((expectation: any) => expectation?.met === false && typeof expectation.name === "string")
                    .map((expectation: any) => expectation.name)
                : [],
            }
          : null,
        reader: row.reader_status
          ? { status: row.reader_status, attempt: row.reader_attempt }
          : null,
        findings: findings.get(row.id) ?? [],
      });
    }
  }
  return [...plans.values()];
}
