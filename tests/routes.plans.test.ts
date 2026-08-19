import { beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import app from "../src/app";
import { sql } from "../src/db";

beforeEach(async () => {
  // plans and plan_revisions are listed too, otherwise every run leaves its
  // plans behind: nothing else truncates them and lanes only reference them.
  await sql`TRUNCATE lanes, messages, approvals, verification_runs, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function createPlan() {
  const planId = `plan-${crypto.randomUUID()}`;
  const res = await app.request("/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan_id: planId, title: "Test plan", content: { objective: "test" } }),
  });
  expect(res.status).toBe(201);
  return { planId, ...(await res.json()) };
}

async function createLane(overrides: Record<string, unknown> = {}) {
  const laneId = `lane-${crypto.randomUUID()}`;
  const res = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      owned_paths: [`src/${laneId}.ts`],
      lane_type: "write",
      depends_on: [],
      worktree_path: tmpdir(),
      original_brief: "test brief",
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return laneId;
}

test("POST /plans creates revision 1 unapproved and approval remains on that row", async () => {
  const { planId, revision, revision_id } = await createPlan();
  expect(revision).toBe(1);

  const approved = await app.request(`/plans/${planId}/revisions/1/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved_by: "human" }),
  });
  expect(approved.status).toBe(200);

  const plan = await (await app.request(`/plans/${planId}`)).json();
  expect(plan.revisions).toEqual([
    expect.objectContaining({
      id: revision_id,
      revision: 1,
      content: { objective: "test" },
      approved_by: "human",
      approved_at: expect.any(String),
    }),
  ]);
});

test("POST /plans/:id/revisions creates the next immutable revision", async () => {
  const { planId } = await createPlan();
  const created = await app.request(`/plans/${planId}/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: { objective: "changed" } }),
  });
  expect(created.status).toBe(201);
  expect((await created.json()).revision).toBe(2);
  const [first] = await sql`
    SELECT content FROM plan_revisions WHERE plan_id = ${planId} AND revision = 1
  `;
  expect(first.content).toEqual({ objective: "test" });
});

test("POST /lanes rejects an unknown plan revision", async () => {
  const res = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: `lane-${crypto.randomUUID()}`,
      owned_paths: ["src/test.ts"],
      lane_type: "write",
      depends_on: [],
      worktree_path: tmpdir(),
      original_brief: "test brief",
      plan_revision_id: crypto.randomUUID(),
    }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid plan_revision_id", field: "plan_revision_id" });
});

test("POST /approvals/:id returns 400 for an invalid resolved_by", async () => {
  const laneId = await createLane();
  await sql`INSERT INTO approvals (lane_id) VALUES (${laneId})`;
  const [approval] = await sql`SELECT id FROM approvals WHERE lane_id = ${laneId}`;
  const res = await app.request(`/approvals/${approval.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolved_by: "operator", decision: "go" }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid resolved_by", field: "resolved_by" });
});

test("DELETE /lanes/:id removes lane records and refuses a running lane", async () => {
  const laneId = await createLane();
  await sql`INSERT INTO messages (lane_id, message_type) VALUES (${laneId}, 'CLAIM')`;
  await sql`INSERT INTO approvals (lane_id) VALUES (${laneId})`;
  const deleted = await app.request(`/lanes/${laneId}`, { method: "DELETE" });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ lane_id: laneId, deleted: true });
  const [lane] = await sql`SELECT lane_id FROM lanes WHERE lane_id = ${laneId}`;
  expect(lane).toBeUndefined();
  const messages = await sql`SELECT 1 FROM messages WHERE lane_id = ${laneId}`;
  const approvals = await sql`SELECT 1 FROM approvals WHERE lane_id = ${laneId}`;
  expect(messages).toHaveLength(0);
  expect(approvals).toHaveLength(0);

  const runningId = await createLane();
  await sql`UPDATE lanes SET status = 'running' WHERE lane_id = ${runningId}`;
  const refused = await app.request(`/lanes/${runningId}`, { method: "DELETE" });
  expect(refused.status).toBe(409);
});

// The plan_id names the integration candidate's branch and worktree, so a
// separator in it escapes the worktree root exactly as a lane_id would. A plan
// the hub accepts but no candidate can be built for dead-ends at integration.
test("POST /plans refuses a plan_id that is not a slug", async () => {
  for (const planId of ["../escape", "plan/with-slash", "", ".."]) {
    const res = await app.request("/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: planId, title: "Test plan", content: { objective: "test" } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid plan_id", field: "plan_id" });
  }
});

async function createRevisionWithLane(status: string) {
  const plan = await createPlan();
  const laneId = await createLane({ plan_revision_id: plan.revision_id });
  await sql`UPDATE lanes SET status = ${status} WHERE lane_id = ${laneId}`;
  return plan;
}

test("GET /candidates/due returns only newest all-completed revisions without a construction run", async () => {
  await createRevisionWithLane("running");
  const due = await createRevisionWithLane("completed");
  const attempted = await createRevisionWithLane("completed");
  await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    VALUES (${attempted.revision_id}, 'construction', 1, 'failed')
  `;

  const res = await app.request("/candidates/due");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([{
    plan_id: due.planId,
    revision: 1,
    revision_id: due.revision_id,
  }]);
});

test("GET /candidates/due ignores a completed revision that is no longer newest", async () => {
  const old = await createRevisionWithLane("completed");
  await app.request(`/plans/${old.planId}/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: { objective: "newest" } }),
  });

  expect(await (await app.request("/candidates/due")).json()).toEqual([]);
});

test("verification run attempts append and a closed run cannot be closed twice", async () => {
  const plan = await createRevisionWithLane("completed");
  const open = () => app.request("/verification-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan_revision_id: plan.revision_id, layer: "construction" }),
  });

  const first = await open();
  expect(first.status).toBe(201);
  const firstRun = await first.json();
  expect(firstRun.attempt).toBe(1);

  const closed = await app.request(`/verification-runs/${firstRun.id}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "failed", detail: { step: "merge", message: "conflict" } }),
  });
  expect(closed.status).toBe(200);
  const second = await open();
  expect(second.status).toBe(201);
  expect((await second.json()).attempt).toBe(2);

  const runs = await sql`
    SELECT attempt FROM verification_runs
    WHERE plan_revision_id = ${plan.revision_id} AND layer = 'construction'
    ORDER BY attempt
  `;
  expect(runs.map((run: any) => run.attempt)).toEqual([1, 2]);
  const latest = await app.request(
    `/verification-runs/latest?plan_revision_id=${plan.revision_id}&layer=construction`,
  );
  expect(await latest.json()).toMatchObject({ attempt: 2, status: "running" });

  const repeated = await app.request(`/verification-runs/${firstRun.id}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "succeeded", detail: {} }),
  });
  expect(repeated.status).toBe(409);
});
