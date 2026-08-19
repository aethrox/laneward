import { beforeEach, expect, test } from "bun:test";
import app from "../src/app";
import { tmpdir } from "node:os";
import { sql } from "../src/db";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

async function registerLane() {
  const laneId = `test-${crypto.randomUUID()}`;
  await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      owned_paths: ["core/*"],
      lane_type: "write",
      model: "terra",
      depends_on: [],
      worktree_path: tmpdir(),
      original_brief: "brief",
    }),
  });
  return laneId;
}

async function requestApproval(laneId: string) {
  await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "APPROVAL_REQUEST", question: "proceed?" }),
  });
}

test("APPROVAL_REQUEST message creates one approval and sets waiting_approval", async () => {
  const laneId = await registerLane();

  for (let i = 0; i < 2; i++) {
    const res = await app.request(`/lanes/${laneId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message_type: "APPROVAL_REQUEST",
        question: "ok to delete X?",
      }),
    });
    expect(res.status).toBe(201);
  }

  const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`;
  expect(lane.status).toBe("waiting_approval");

  const approvals = await sql`SELECT resolved_at FROM approvals WHERE lane_id = ${laneId}`;
  expect(approvals).toHaveLength(1);
  expect(approvals[0].resolved_at).toBeNull();
});

test("message records dispatcher-provided evidence references", async () => {
  const laneId = await registerLane();
  const evidenceRefs = { files: ["core/db.ts"], tests: "8 pass" };
  const res = await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "EVIDENCE", evidence_refs: evidenceRefs }),
  });
  expect(res.status).toBe(201);

  const [message] = await sql`SELECT evidence_refs FROM messages WHERE lane_id = ${laneId}`;
  expect(message.evidence_refs).toEqual(evidenceRefs);
});

test("result with exit_code 0 trusts the reported evidence verdict", async () => {
  const passedId = await registerLane();
  const passed = await app.request(`/lanes/${passedId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 0, evidence_passed: true }),
  });
  expect(passed.status).toBe(200);

  let [lane] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = ${passedId}`;
  expect(lane).toMatchObject({ status: "completed", attempt_count: 0 });

  await sql`UPDATE lanes SET status = 'pending' WHERE lane_id = ${passedId}`;
  await app.request(`/lanes/${passedId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 0, evidence_passed: false }),
  });
  [lane] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = ${passedId}`;
  expect(lane).toMatchObject({ status: "failed", attempt_count: 0 });
});

test("exit_code 0 does not overwrite a lane with an unresolved approval", async () => {
  const laneId = await registerLane();
  await requestApproval(laneId);

  const res = await app.request(`/lanes/${laneId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 0, evidence_passed: false }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "waiting_approval", attempt_count: 0 });
  const [lane] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = ${laneId}`;
  expect(lane).toMatchObject({ status: "waiting_approval", attempt_count: 0 });
});

test("exit_code 20 does not retry a lane with an unresolved approval", async () => {
  const laneId = await registerLane();
  await requestApproval(laneId);

  const res = await app.request(`/lanes/${laneId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 20 }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "waiting_approval", attempt_count: 0 });
  const [lane] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = ${laneId}`;
  expect(lane).toMatchObject({ status: "waiting_approval", attempt_count: 0 });
});

test("result applies normally after an approval is resolved", async () => {
  const laneId = await registerLane();
  await requestApproval(laneId);

  await sql`UPDATE approvals SET resolved_at = now() WHERE lane_id = ${laneId}`;
  const res = await app.request(`/lanes/${laneId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 0, evidence_passed: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "completed", attempt_count: 0 });
});

test("result with exit_code 30 fails immediately without incrementing", async () => {
  const laneId = await registerLane();
  await app.request(`/lanes/${laneId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 30 }),
  });
  const [lane] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = ${laneId}`;
  expect(lane).toMatchObject({ status: "failed", attempt_count: 0 });
});

test("only exit_code 20 increments attempt_count and the third failure is terminal", async () => {
  const laneId = await registerLane();

  for (let i = 1; i <= 3; i++) {
    const res = await app.request(`/lanes/${laneId}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exit_code: 20 }),
    });
    expect(res.status).toBe(200);
    const [lane] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = ${laneId}`;
    expect(lane.attempt_count).toBe(i);
    expect(lane.status).toBe(i === 3 ? "failed" : "pending");
  }

  const exitTen = await app.request(`/lanes/${laneId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 10 }),
  });
  expect(exitTen.status).toBe(400);
  const [lane] = await sql`SELECT attempt_count FROM lanes WHERE lane_id = ${laneId}`;
  expect(lane.attempt_count).toBe(3);
});

test("result for an unknown lane returns 404 instead of a silent 200", async () => {
  const res = await app.request("/lanes/does-not-exist/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exit_code: 30 }),
  });
  expect(res.status).toBe(404);
});
