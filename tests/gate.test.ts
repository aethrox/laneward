import { test, expect, beforeEach } from "bun:test";
import { pathsOverlap } from "../src/gate";
import { tmpdir } from "node:os";

test("pathsOverlap detects directory-glob conflicts", () => {
  expect(pathsOverlap(["core/*"], ["cli/*"])).toBe(false);
  expect(pathsOverlap(["core/*"], ["core/*"])).toBe(true);
  expect(pathsOverlap(["core/db.ts"], ["core/*"])).toBe(true);
  expect(pathsOverlap(["core/db/*"], ["core/*"])).toBe(true);
  expect(pathsOverlap(["docs/*"], ["web/*"])).toBe(false);
});

import { sql as db } from "../src/db";
import { checkGate } from "../src/gate";

// Leftover `running` lanes from a previous run trip the active-lane limit
// before the check under test, so each test starts from an empty store.
beforeEach(async () => {
  await db`TRUNCATE lanes, messages, approvals, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function insertLane(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    lane_id: `test-${crypto.randomUUID()}`,
    owned_paths: ["core/*"],
    lane_type: "write",
    model: "balanced",
    depends_on: [],
    status: "pending",
    worktree_path: tmpdir(),
    original_brief: "test brief",
    plan_revision_id: null,
    ...overrides,
  };
  await db`
    INSERT INTO lanes
      (lane_id, owned_paths, lane_type, model, depends_on, status, worktree_path, original_brief, plan_revision_id)
    VALUES (
      ${base.lane_id},
      ${db.array(base.owned_paths as string[], "text")},
      ${base.lane_type},
      ${base.model},
      ${db.array(base.depends_on as string[], "text")},
      ${base.status},
      ${base.worktree_path},
      ${base.original_brief},
      ${base.plan_revision_id}
    )
  `;
  return base.lane_id;
}

async function insertPlanRevision(approved = false) {
  const planId = `plan-${crypto.randomUUID()}`;
  await db`INSERT INTO plans (plan_id, title) VALUES (${planId}, 'test plan')`;
  const [revision] = await db`
    INSERT INTO plan_revisions (plan_id, revision, content, approved_at, approved_by)
    VALUES (${planId}, 1, ${{ objective: "test" }}, ${approved ? new Date() : null}, ${approved ? "human" : null})
    RETURNING id
  `;
  return { planId, revisionId: revision.id };
}

test("checkGate allows a lane with no dependencies and no conflicts", async () => {
  const laneId = await insertLane();
  const result = await checkGate(laneId);
  expect(result).toEqual({ allowed: true, reason: "ok" });
});

test("checkGate blocks on an incomplete dependency", async () => {
  const depId = await insertLane({ status: "running" });
  const laneId = await insertLane({ depends_on: [depId] });
  const result = await checkGate(laneId);
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain("dependency not completed");
});

// A typo'd lane_id must not read as a satisfied dependency: an unmatched
// IN-list would open the gate silently and skip the check entirely.
test("checkGate blocks on a dependency that does not exist", async () => {
  const laneId = await insertLane({ depends_on: ["never-registered"] });
  const result = await checkGate(laneId);
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain("dependency not found: never-registered");
});

test("checkGate blocks on owned_paths conflict with a running lane", async () => {
  await insertLane({ owned_paths: ["web/*"], status: "running" });
  const laneId = await insertLane({ owned_paths: ["web/*"] });
  const result = await checkGate(laneId);
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain("conflict");
});

test("checkGate blocks on a pending approval for the same lane", async () => {
  const laneId = await insertLane();
  await db`INSERT INTO approvals (lane_id) VALUES (${laneId})`;
  const result = await checkGate(laneId);
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain("pending approval");
});

test("checkGate blocks a lane bound to an unapproved plan revision", async () => {
  const { revisionId } = await insertPlanRevision();
  const laneId = await insertLane({ plan_revision_id: revisionId });
  expect(await checkGate(laneId)).toEqual({
    allowed: false,
    reason: "lane's plan revision is not approved",
  });
});

test("checkGate allows an approved revision and blocks it after a newer revision", async () => {
  const { planId, revisionId } = await insertPlanRevision(true);
  const laneId = await insertLane({ plan_revision_id: revisionId });
  expect(await checkGate(laneId)).toEqual({ allowed: true, reason: "ok" });

  await db`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES (${planId}, 2, ${{ objective: "changed" }})
  `;
  expect(await checkGate(laneId)).toEqual({
    allowed: false,
    reason: "lane's plan revision 1 is superseded by revision 2",
  });
});
