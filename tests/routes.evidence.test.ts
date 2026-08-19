import { beforeEach, expect, test } from "bun:test";
import app from "../src/app";
import { tmpdir } from "node:os";
import { sql } from "../src/db";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

async function registerLane(): Promise<string> {
  const laneId = `evidence-${crypto.randomUUID()}`;
  const response = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      owned_paths: ["src/*"],
      lane_type: "write",
      worktree_path: tmpdir(),
      original_brief: "brief",
    }),
  });
  expect(response.status).toBe(201);
  return laneId;
}

test("GET /lanes/:id/evidence returns the posted jsonb object through the API route", async () => {
  const laneId = await registerLane();
  const payload = {
    schema_version: 1,
    source: "lane_checks",
    manifest_path: "/tmp/worktree/.laneward/project.json",
    overall: "passed",
    started_at: "2026-08-08T10:00:00.000Z",
    finished_at: "2026-08-08T10:00:01.000Z",
    checks: [{
      name: "unit",
      command: ["bun", "test"],
      status: "passed",
      exit_code: 0,
      duration_ms: 1000,
      output_path: "/tmp/logs/lane.check-0-unit.log",
      error: null,
    }],
  };
  const posted = await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "EVIDENCE", evidence_refs: payload }),
  });
  expect(posted.status).toBe(201);
  await app.request(`/lanes/${laneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_type: "EVIDENCE", evidence_refs: { ...payload, overall: "failed" } }),
  });

  const response = await app.request(`/lanes/${laneId}/evidence`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.lane_id).toBe(laneId);
  expect(body.evidence).toHaveLength(2);
  expect(body.evidence.map((item: any) => item.evidence_refs.overall)).toEqual(["failed", "passed"]);
  expect(body.evidence[1].evidence_refs).toEqual(payload);
  expect(body.evidence[0].id).toBeNumber();
  expect(body.evidence[0].created_at).toBeString();
});

test("evidence read distinguishes an unknown lane from a known lane with no evidence", async () => {
  expect((await app.request("/lanes/does-not-exist/evidence")).status).toBe(404);

  const laneId = await registerLane();
  const response = await app.request(`/lanes/${laneId}/evidence`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ lane_id: laneId, evidence: [] });
});
