import { beforeEach, expect, test } from "bun:test";
import app from "../src/app";
import { sql } from "../src/db";
import { tmpdir } from "node:os";
import { join } from "node:path";

// POST /lanes now rejects a worktree that does not exist, so every fixture
// needs a real directory.
const existingPath = tmpdir();

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

test("POST /lanes rejects a missing lane_id", async () => {
  const res = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owned_paths: ["core/*"],
      lane_type: "write",
      depends_on: [],
      worktree_path: existingPath,
      original_brief: "test brief",
    }),
  });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid lane_id", field: "lane_id" });
});

// The id becomes `<worktree-root>/<lane_id>` and `lane/<lane_id>`, so a
// separator or a `..` segment in it escapes the worktree root entirely.
test("POST /lanes rejects a lane_id that is not a slug", async () => {
  for (const laneId of ["../escape", "a/b", "a\\b", ".", "..", "-leading", "with space", "x".repeat(65)]) {
    const res = await app.request("/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lane_id: laneId,
        owned_paths: ["core/*"],
        lane_type: "write",
        depends_on: [],
        worktree_path: existingPath,
        original_brief: "test brief",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid lane_id", field: "lane_id" });
  }
});

test("POST /lanes rejects an invalid lane_type", async () => {
  const res = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: `test-${crypto.randomUUID()}`,
      owned_paths: ["core/*"],
      lane_type: "feature",
      depends_on: [],
      worktree_path: existingPath,
      original_brief: "test brief",
    }),
  });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid lane_type", field: "lane_type" });
});

test("POST /lanes defaults model to balanced and rejects an invalid model", async () => {
  const laneId = `test-${crypto.randomUUID()}`;
  const registered = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      owned_paths: ["model/*"],
      lane_type: "write",
      depends_on: [],
      worktree_path: existingPath,
      original_brief: "default model",
    }),
  });
  expect(registered.status).toBe(201);
  const [stored] = await sql`SELECT model FROM lanes WHERE lane_id = ${laneId}`;
  expect(stored.model).toBe("balanced");

  const invalid = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: `test-${crypto.randomUUID()}`,
      owned_paths: ["invalid-model/*"],
      lane_type: "write",
      model: "gpt5",
      depends_on: [],
      worktree_path: existingPath,
      original_brief: "invalid model",
    }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "invalid model", field: "model" });
});

test("POST /lanes registers a lane, GET /lanes/:id/gate reports allowed", async () => {
  const laneId = `test-${crypto.randomUUID()}`;
  const registerRes = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      owned_paths: ["core/*"],
      lane_type: "write",
      model: "balanced",
      depends_on: [],
      worktree_path: existingPath,
      original_brief: "test brief",
    }),
  });
  expect(registerRes.status).toBe(201);

  const gateRes = await app.request(`/lanes/${laneId}/gate`);
  expect(gateRes.status).toBe(200);
  expect(await gateRes.json()).toEqual({ allowed: true, reason: "ok" });
});

test("POST /lanes rejects a second lane whose owned_paths overlap", async () => {
  const laneId = `test-${crypto.randomUUID()}`;
  await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      owned_paths: ["web/*"],
      lane_type: "write",
      model: "balanced",
      depends_on: [],
      worktree_path: existingPath,
      original_brief: "first",
    }),
  });

  const res = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: `test-${crypto.randomUUID()}`,
      owned_paths: ["web/*"],
      lane_type: "write",
      model: "balanced",
      depends_on: [],
      worktree_path: existingPath,
      original_brief: "second",
    }),
  });
  expect(res.status).toBe(409);
});

// A lane registered against a path that does not exist only fails when the
// worker is dispatched, and it fails three times: the conductor retries, every
// attempt dies on "The system cannot find the file specified", and the lane
// ends up `failed` as though its own work were at fault.
test("POST /lanes rejects a worktree_path that does not exist", async () => {
  const res = await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: `test-${crypto.randomUUID()}`,
      owned_paths: ["core/*"],
      lane_type: "write",
      depends_on: [],
      worktree_path: join(tmpdir(), `laneward-absent-${crypto.randomUUID()}`),
      original_brief: "test brief",
    }),
  });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid worktree_path", field: "worktree_path" });
});
