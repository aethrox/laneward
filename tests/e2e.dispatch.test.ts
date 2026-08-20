import { beforeEach, expect, test } from "bun:test";
import app from "../src/app";
import { tmpdir } from "node:os";
import { sql } from "../src/db";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

test("two dependent lanes: gate blocks until dependency completes, then approval flow resolves", async () => {
  const laneA = `test-a-${crypto.randomUUID()}`;
  const laneB = `test-b-${crypto.randomUUID()}`;

  // 1. Register lane A (no dependencies) and lane B (depends on A).
  await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneA,
      owned_paths: ["core/*"],
      lane_type: "write",
      model: "balanced",
      depends_on: [],
      worktree_path: tmpdir(),
      original_brief: "implement core",
    }),
  });
  await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneB,
      owned_paths: ["web/*"],
      lane_type: "write",
      model: "balanced",
      depends_on: [laneA],
      worktree_path: tmpdir(),
      original_brief: "implement web on top of core",
    }),
  });

  // 2. Lane B's gate is blocked because A isn't completed yet.
  let gateB = await (await app.request(`/lanes/${laneB}/gate`)).json();
  expect(gateB.allowed).toBe(false);
  expect(gateB.reason).toContain("dependency not completed");

  // 3. Lane A's gate is open; dispatch it, it completes cleanly.
  const gateA = await (await app.request(`/lanes/${laneA}/gate`)).json();
  expect(gateA.allowed).toBe(true);
  await sql`UPDATE lanes SET status = 'running' WHERE lane_id = ${laneA}`;
  await app.request(`/lanes/${laneA}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 0, evidence_passed: true }),
  });
  const [aAfter] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneA}`;
  expect(aAfter.status).toBe("completed");

  // 4. Now lane B's gate opens.
  gateB = await (await app.request(`/lanes/${laneB}/gate`)).json();
  expect(gateB).toEqual({ allowed: true, reason: "ok" });

  // 5. Dispatch B; it hits a decision point and asks for approval (exit 10).
  await sql`UPDATE lanes SET status = 'running' WHERE lane_id = ${laneB}`;
  await app.request(`/lanes/${laneB}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message_type: "APPROVAL_REQUEST",
      question: "core/ exports changed shape, proceed with the web adapter as planned?",
    }),
  });

  // 6. It shows up in /pending; B's own gate is now blocked by its own approval.
  const pending = await (await app.request("/pending")).json();
  const entry = pending.waiting_approval.find((l: any) => l.lane_id === laneB);
  expect(entry).toBeDefined();
  expect(entry.question).toContain("proceed with the web adapter");

  const gateBBlocked = await (await app.request(`/lanes/${laneB}/gate`)).json();
  expect(gateBBlocked.allowed).toBe(false);
  expect(gateBBlocked.reason).toContain("pending approval");

  // 7. Orchestrator resolves the approval.
  const [approval] = await sql`SELECT id FROM approvals WHERE lane_id = ${laneB}`;
  const approveRes = await app.request(`/approvals/${approval.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "yes, proceed", resolved_by: "claude" }),
  });
  expect(approveRes.status).toBe(200);

  // 8. Gate reopens; B is redispatched and completes.
  const gateBReopened = await (await app.request(`/lanes/${laneB}/gate`)).json();
  expect(gateBReopened).toEqual({ allowed: true, reason: "ok" });

  await app.request(`/lanes/${laneB}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 0, evidence_passed: true }),
  });
  const [bAfter] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneB}`;
  expect(bAfter.status).toBe("completed");

  // 9. Neither lane is in /pending anymore.
  const pendingAfter = await (await app.request("/pending")).json();
  expect(pendingAfter.waiting_approval.some((l: any) => l.lane_id === laneB)).toBe(false);
  expect(pendingAfter.failed.some((l: any) => l.lane_id === laneA || l.lane_id === laneB)).toBe(false);
});
