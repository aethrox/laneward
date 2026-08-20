import { beforeEach, expect, test } from "bun:test";
import app from "../src/app";
import { tmpdir } from "node:os";
import { sql } from "../src/db";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals, verification_runs, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function registerLane(ownedPaths: string[]) {
  const laneId = `test-${crypto.randomUUID()}`;
  await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      owned_paths: ownedPaths,
      lane_type: "write",
      model: "balanced",
      depends_on: [],
      worktree_path: tmpdir(),
      original_brief: "brief",
    }),
  });
  return laneId;
}

test("GET /pending lists waiting_approval questions, failed lanes, and open findings", async () => {
  const waitingId = await registerLane(["a/*"]);
  await app.request(`/lanes/${waitingId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "proceed?" }),
  });

  const failedId = await registerLane(["b/*"]);
  await app.request(`/lanes/${failedId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 30 }),
  });
  await sql`INSERT INTO plans (plan_id, title) VALUES ('reader-plan', 'Reader Plan')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('reader-plan', 1, ${{ objective: "test" }}) RETURNING id
  `;
  const [run] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    VALUES (${revision.id}, 'reader', 1, 'succeeded') RETURNING id
  `;
  await sql`
    INSERT INTO verification_findings (verification_run_id, finding, subject, locations)
    VALUES (${run.id}, 'Reader concern', 'source_context', ${[
      { path: "src/app.ts", side: "head", start_line: 1, end_line: 2 },
    ]})
  `;
  await sql`
    UPDATE verification_findings SET raised_at = now() - interval '1 minute'
    WHERE verification_run_id = ${run.id}
  `;
  await sql`
    INSERT INTO verification_findings (verification_run_id, finding, subject)
    VALUES (${run.id}, 'Newest reader concern', 'test_diff')
  `;

  const res = await app.request("/pending");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.waiting_approval.find((lane: any) => lane.lane_id === waitingId)?.question).toBe("proceed?");
  expect(body.failed.some((lane: any) => lane.lane_id === failedId)).toBe(true);
  expect(body.findings).toContainEqual(expect.objectContaining({
    plan_id: "reader-plan",
    revision: 1,
    finding: "Reader concern",
    subject: "source_context",
    locations: [{ path: "src/app.ts", side: "head", start_line: 1, end_line: 2 }],
  }));
  expect(body.findings[0].finding).toBe("Newest reader concern");
  expect(body.waiting_approval.some((item: any) => item.finding === "Reader concern")).toBe(false);
});

test("GET /pending omits adjudicated findings", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('reader-plan', 'Reader Plan')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('reader-plan', 1, ${{ objective: "test" }}) RETURNING id
  `;
  const [run] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    VALUES (${revision.id}, 'reader', 1, 'succeeded') RETURNING id
  `;
  await sql`
    INSERT INTO verification_findings (verification_run_id, finding, subject, state)
    VALUES (${run.id}, 'Settled concern', 'test_diff', 'rejected')
  `;

  expect((await (await app.request("/pending")).json()).findings).toEqual([]);
});

test("POST /approvals/:id resolves once, then returns 409", async () => {
  const laneId = await registerLane(["c/*"]);
  await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "proceed?" }),
  });
  const [approval] = await sql`SELECT id FROM approvals WHERE lane_id = ${laneId}`;

  const first = await app.request(`/approvals/${approval.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "yes, proceed", resolved_by: "human" }),
  });
  expect(first.status).toBe(200);

  const second = await app.request(`/approvals/${approval.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "no", resolved_by: "human" }),
  });
  expect(second.status).toBe(409);
});

test("a failed construction approval is plan-revision scoped and visible in GET /pending", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('candidate-plan', 'Candidate Plan')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('candidate-plan', 2, ${{ objective: "test" }})
    RETURNING id
  `;
  await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status, detail, finished_at)
    VALUES (${revision.id}, 'construction', 1, 'failed',
      ${{ step: "merge of lane/a", message: "conflict" }}, now())
  `;

  const raised = await app.request(`/plan-revisions/${revision.id}/approvals`, { method: "POST" });
  expect(raised.status).toBe(201);

  const [approval] = await sql`SELECT subject_kind, lane_id, plan_revision_id FROM approvals`;
  expect(approval).toMatchObject({
    subject_kind: "plan_revision",
    lane_id: null,
    plan_revision_id: revision.id,
  });
  const pending = await (await app.request("/pending")).json();
  expect(pending.waiting_approval).toContainEqual(expect.objectContaining({
    subject_kind: "plan_revision",
    plan_id: "candidate-plan",
    revision: 2,
    plan_revision_id: revision.id,
    question: expect.stringContaining("merge of lane/a: conflict"),
  }));
});
