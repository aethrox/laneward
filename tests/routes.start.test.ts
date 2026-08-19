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

test("POST /lanes/:id/start starts a pending lane with an open gate", async () => {
  const laneId = await registerLane();
  const res = await app.request(`/lanes/${laneId}/start`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lane_id: laneId, status: "running" });
  const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`;
  expect(lane.status).toBe("running");
});

test("POST /lanes/:id/start rejects a lane with an incomplete dependency", async () => {
  const dependencyId = await registerLane();
  const laneId = await registerLane({
    owned_paths: ["web/*"],
    depends_on: [dependencyId],
  });
  const res = await app.request(`/lanes/${laneId}/start`, { method: "POST" });
  const body = await res.json();

  expect(res.status).toBe(409);
  expect(body.error).toBe("gate closed");
  expect(body.reason).toContain("dependency not completed");
});

test("POST /lanes/:id/start rejects an already-running lane", async () => {
  const laneId = await registerLane();
  await sql`UPDATE lanes SET status = 'running' WHERE lane_id = ${laneId}`;
  const res = await app.request(`/lanes/${laneId}/start`, { method: "POST" });

  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("running");
});

async function requestApproval(laneId: string) {
  await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "may I?" }),
  });
  const [approval] = await sql`
    SELECT id FROM approvals WHERE lane_id = ${laneId} AND resolved_at IS NULL
  `;
  return approval.id as number;
}

// A resumed lane must reach 'running' like any other, or the gate stops
// counting it for MAX_ACTIVE_LANES and for owned_paths conflicts while it runs.
test("POST /lanes/:id/start starts a lane whose approval has been resolved", async () => {
  const laneId = await registerLane();
  const approvalId = await requestApproval(laneId);
  await app.request(`/approvals/${approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolved_by: "human", decision: "go ahead" }),
  });

  const res = await app.request(`/lanes/${laneId}/start`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lane_id: laneId, status: "running" });
});

test("POST /lanes/:id/start rejects a lane whose approval is still unresolved", async () => {
  const laneId = await registerLane();
  await requestApproval(laneId);

  const res = await app.request(`/lanes/${laneId}/start`, { method: "POST" });
  const body = await res.json();

  expect(res.status).toBe(409);
  expect(body.error).toBe("gate closed");
  expect(body.reason).toContain("pending approval");
});

test("POST /lanes/:id/start returns 404 for an unknown lane", async () => {
  const res = await app.request("/lanes/missing/start", { method: "POST" });

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "lane not found" });
});
