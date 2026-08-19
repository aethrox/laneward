import { beforeEach, expect, test } from "bun:test";
import app from "../src/app";
import { tmpdir } from "node:os";
import { sql } from "../src/db";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

async function registerLane(overrides: Record<string, unknown> = {}) {
  const lane = {
    lane_id: `test-${crypto.randomUUID()}`,
    owned_paths: ["core/*"],
    lane_type: "write",
    model: "terra",
    depends_on: [],
    worktree_path: tmpdir(),
    original_brief: "test brief",
    ...overrides,
  };
  await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(lane),
  });
  return lane.lane_id;
}

async function dispatchable() {
  const res = await app.request("/lanes/dispatchable");
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
}

test("GET /lanes/dispatchable returns pending lanes with a null resume_decision", async () => {
  const laneId = await registerLane();

  const lanes = await dispatchable();

  expect(lanes).toHaveLength(1);
  expect(lanes[0]).toMatchObject({
    lane_id: laneId,
    owned_paths: ["core/*"],
    lane_type: "write",
    model: "terra",
    depends_on: [],
    worktree_path: tmpdir(),
    original_brief: "test brief",
    resume_decision: null,
  });
});

test("GET /lanes/dispatchable omits running and completed lanes", async () => {
  const laneId = await registerLane();
  await sql`UPDATE lanes SET status = 'running' WHERE lane_id = ${laneId}`;

  expect(await dispatchable()).toHaveLength(0);

  await sql`UPDATE lanes SET status = 'completed' WHERE lane_id = ${laneId}`;

  expect(await dispatchable()).toHaveLength(0);
});

test("GET /lanes/dispatchable omits a lane whose approval is still unresolved", async () => {
  const laneId = await registerLane();
  await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "may I?" }),
  });

  expect(await dispatchable()).toHaveLength(0);
});

test("GET /lanes/dispatchable returns a resolved-approval lane with its decision", async () => {
  const laneId = await registerLane();
  await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "may I?" }),
  });
  const [approval] = await sql`SELECT id FROM approvals WHERE lane_id = ${laneId}`;
  await app.request(`/approvals/${approval.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolved_by: "human", decision: "go ahead, use option B" }),
  });

  const lanes = await dispatchable();

  expect(lanes).toHaveLength(1);
  expect(lanes[0]).toMatchObject({
    lane_id: laneId,
    resume_decision: "go ahead, use option B",
  });
});

test("GET /lanes/dispatchable returns one row per lane with two resolved approvals", async () => {
  const laneId = await registerLane();

  for (const decision of ["first answer", "second answer"]) {
    await app.request(`/lanes/${laneId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "may I?" }),
    });
    const [open] = await sql`
      SELECT id FROM approvals WHERE lane_id = ${laneId} AND resolved_at IS NULL
    `;
    await app.request(`/approvals/${open.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolved_by: "human", decision }),
    });
  }

  const lanes = await dispatchable();

  expect(lanes).toHaveLength(1);
  expect(lanes[0].resume_decision).toBe("second answer");
});
