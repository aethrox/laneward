import { beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../src/app";
import { sql } from "../src/db";
import { planSnapshot, snapshot, type DashboardConfig } from "../src/dashboard-data";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals, verification_runs, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function tempConfig(): Promise<DashboardConfig> {
  return {
    logDir: await mkdtemp(join(tmpdir(), "dashboard-snapshot-")),
    pollMs: 10,
    picoPath: "/dev/null",
  };
}

// owned_paths is text[]; registering over HTTP avoids binding a bare JS array.
async function registerLane(laneId: string, ownedPaths: string[]) {
  const response = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      lane_type: "write",
      model: "balanced",
      worktree_path: tmpdir(),
      owned_paths: ownedPaths,
      original_brief: "brief",
    }),
  });
  expect(response.status).toBe(201);
}

test("empty snapshots return empty arrays", async () => {
  expect(await snapshot(await tempConfig())).toEqual([]);
  expect(await planSnapshot()).toEqual([]);
});

test("snapshot returns every lane with its owned paths", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  const lanes = await snapshot(await tempConfig());
  expect(lanes).toHaveLength(1);
  expect(lanes[0].lane_id).toBe("alpha");
  expect(lanes[0].status).toBe("pending");
  expect(lanes[0].owned_paths).toEqual(["src/a.ts"]);
  expect(lanes[0].attempt_count).toBe(0);
});

test("snapshot carries the newest message and the pending approval question", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  await app.request("/lanes/alpha/start", { method: "POST" });
  const posted = await app.request("/lanes/alpha/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "may I widen the scope?" }),
  });
  expect(posted.status).toBe(201);

  const [lane] = await snapshot(await tempConfig());
  expect(lane.status).toBe("waiting_approval");
  expect(lane.last_message_type).toBe("APPROVAL_REQUEST");
  expect(lane.pending_question).toBe("may I widen the scope?");
  expect(lane.approval_id).not.toBeNull();
  expect(lane.last_message_at).not.toBeNull();
});

test("snapshot carries evidence newest first with its references intact", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  for (const evidence_refs of [{ files: ["first.ts"] }, { files: ["second.ts"] }]) {
    const response = await app.request("/lanes/alpha/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_type: "EVIDENCE", evidence_refs }),
    });
    expect(response.status).toBe(201);
  }

  const [lane] = await snapshot(await tempConfig());
  expect(lane.evidence.map((item) => item.evidence_refs)).toEqual([
    { files: ["second.ts"] },
    { files: ["first.ts"] },
  ]);
  expect(lane.evidence.every((item) => typeof item.created_at === "string")).toBe(true);
});

test("snapshot caps evidence at the newest ten messages", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  for (let i = 1; i <= 12; i++) {
    await app.request("/lanes/alpha/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_type: "EVIDENCE", evidence_refs: { sequence: i } }),
    });
  }

  const [lane] = await snapshot(await tempConfig());
  expect(lane.evidence).toHaveLength(10);
  expect(lane.evidence.map((item: any) => item.evidence_refs.sequence)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
});

test("snapshot carries resolved and unresolved approval history", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  await sql`
    INSERT INTO approvals (lane_id, requested_at, resolved_at, decision, resolved_by, verified_by)
    VALUES ('alpha', ${new Date(1000)}, ${new Date(2000)}, 'proceed', 'human', 'claude')
  `;
  await sql`INSERT INTO approvals (lane_id, requested_at) VALUES ('alpha', ${new Date(3000)})`;

  const [lane] = await snapshot(await tempConfig());
  expect(lane.approvals).toHaveLength(2);
  expect(lane.approvals[0]).toMatchObject({ resolved_at: null, decision: null, resolved_by: null, verified_by: null });
  expect(lane.approvals[1]).toMatchObject({ decision: "proceed", resolved_by: "human", verified_by: "claude" });
  expect(lane.approvals[1].resolved_at).toBe(new Date(2000).toISOString());
});

test("snapshot uses empty evidence and approval arrays when a lane has none", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  const [lane] = await snapshot(await tempConfig());
  expect(lane.evidence).toEqual([]);
  expect(lane.approvals).toEqual([]);
});

test("plan snapshot marks the newest revision and its approval state", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('plan-a', 'Plan A')`;
  await sql`
    INSERT INTO plan_revisions (plan_id, revision, content, approved_at, approved_by)
    VALUES ('plan-a', 1, ${{ objective: "first" }}, ${new Date(1000)}, 'human')
  `;
  await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('plan-a', 2, ${{ objective: "second" }})
  `;

  const [plan] = await planSnapshot();
  expect(plan).toMatchObject({ plan_id: "plan-a", title: "Plan A" });
  expect(plan.revisions).toMatchObject([
    { revision: 2, approved: false, approved_by: null, is_newest: true },
    { revision: 1, approved: true, approved_by: "human", is_newest: false },
  ]);
});

test("plan snapshot carries a pending construction approval", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('plan-a', 'Plan A')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('plan-a', 1, ${{ objective: "test" }}) RETURNING id
  `;
  await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status, detail, finished_at)
    VALUES (${revision.id}, 'construction', 1, 'failed',
      ${{ step: "bun install", message: "package missing" }}, now())
  `;
  await app.request(`/plan-revisions/${revision.id}/approvals`, { method: "POST" });

  const [plan] = await planSnapshot();

  expect(plan.revisions[0]).toMatchObject({
    approval_id: expect.any(String),
    pending_question: expect.stringContaining("bun install: package missing"),
  });
});

test("plan snapshot carries the latest construction and clean run outcomes with unmet expectations", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('plan-a', 'Plan A')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('plan-a', 1, ${{ objective: "test" }}) RETURNING id
  `;
  await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status, detail, finished_at)
    VALUES
      (${revision.id}, 'construction', 1, 'failed', ${{ message: "old" }}, now()),
      (${revision.id}, 'construction', 2, 'succeeded', ${{ worktree_path: "C:/candidate" }}, now()),
      (${revision.id}, 'clean_run', 1, 'failed', ${{
        expectations: [
          { name: "approval notification", met: false },
          { name: "no delivery failures", met: true },
        ],
      }}, now())
  `;

  const [plan] = await planSnapshot();

  expect(plan.revisions[0]).toMatchObject({
    construction: { status: "succeeded", attempt: 2 },
    clean_run: {
      status: "failed",
      attempt: 1,
      unmet_expectations: ["approval notification"],
    },
  });
});

test("plan snapshot carries reader state and open findings", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('plan-a', 'Plan A')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('plan-a', 1, ${{ objective: "test" }}) RETURNING id
  `;
  const [reader] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    VALUES (${revision.id}, 'reader', 1, 'succeeded') RETURNING id
  `;
  await sql`
    INSERT INTO verification_findings (verification_run_id, finding, subject, locations)
    VALUES (${reader.id}, 'Reader concern', 'test_diff', ${[
      { path: "tests/reader.test.ts", side: "head", start_line: 4, end_line: 4 },
    ]})
  `;

  const [plan] = await planSnapshot();

  expect(plan.revisions[0]).toMatchObject({
    reader: { status: "succeeded", attempt: 1 },
    findings: [{
      finding: "Reader concern",
      subject: "test_diff",
      locations: [{ path: "tests/reader.test.ts", side: "head", start_line: 4, end_line: 4 }],
    }],
  });
});

test("plan snapshot distinguishes a skipped reader from one with no findings", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('plan-a', 'Plan A')`;
  await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('plan-a', 1, ${{ objective: "skipped" }}), ('plan-a', 2, ${{ objective: "empty" }})
  `;
  await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    SELECT id, 'reader', 1, CASE WHEN revision = 1 THEN 'skipped' ELSE 'no_findings' END
    FROM plan_revisions WHERE plan_id = 'plan-a'
  `;

  const [plan] = await planSnapshot();

  expect(plan.revisions.map((revision) => revision.reader?.status)).toEqual(["no_findings", "skipped"]);
  expect(plan.revisions.every((revision) => revision.findings.length === 0)).toBe(true);
});

test("snapshot retains an unbound lane", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  const [lane] = await snapshot(await tempConfig());
  expect(lane.plan_revision_id).toBeNull();
});

test("snapshot reports the log size from disk", async () => {
  const cfg = await tempConfig();
  await registerLane("alpha", ["src/a.ts"]);
  await writeFile(join(cfg.logDir, "alpha.log"), "1234567890");
  const [lane] = await snapshot(cfg);
  expect(lane.log_bytes).toBe(10);
});

test("snapshot reports zero bytes when no log exists yet", async () => {
  await registerLane("alpha", ["src/a.ts"]);
  const [lane] = await snapshot(await tempConfig());
  expect(lane.log_bytes).toBe(0);
});

test("snapshot orders the most recently active lane first", async () => {
  await registerLane("older", ["src/a.ts"]);
  await registerLane("newer", ["src/b.ts"]);
  for (const laneId of ["older", "newer"]) {
    await app.request(`/lanes/${laneId}/start`, { method: "POST" });
    await app.request(`/lanes/${laneId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_type: "CLAIM", question: "done" }),
    });
  }
  const lanes = await snapshot(await tempConfig());
  expect(lanes.map((lane) => lane.lane_id)).toEqual(["newer", "older"]);
});
