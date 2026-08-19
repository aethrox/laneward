import { beforeEach, expect, test } from "bun:test";
import { reclaimStrandedConstructionRuns, reclaimStrandedLanes } from "../scripts/reset-stranded";
import { sql } from "../src/db";

beforeEach(async () => {
  await sql`TRUNCATE verification_runs, plans, plan_revisions RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

async function insertLane(laneId: string, status: string, attemptCount = 0) {
  await sql`
    INSERT INTO lanes (lane_id, owned_paths, lane_type, status, worktree_path, attempt_count, original_brief)
    VALUES (${laneId}, ${sql.array([`${laneId}.txt`], "text")}, 'write', ${status},
            ${`/tmp/${laneId}`}, ${attemptCount}, 'brief')
  `;
}

const laneRows = () => sql`SELECT lane_id, status, attempt_count FROM lanes ORDER BY lane_id`;

// The Windows counterpart of tests/conductor.signals.test.ts, which skips on
// win32 because there is no catchable SIGTERM there. That skip records that the
// shutdown path was not tested; this records what is true instead. Stopping the
// Scheduled Task kills the conductor outright, so the lane it was running is
// left `running` with no worker behind it and this function is the only thing
// that brings it back. Observed on 2026-08-19, see
// docs/notes/2026-08-19-s3-windows-end-to-end.md.
test("a stranded lane returns to pending without being charged an attempt", async () => {
  await insertLane("stranded", "running", 1);
  await insertLane("finished", "completed");
  await insertLane("queued", "pending");

  expect(await reclaimStrandedLanes(true, false)).toEqual([{ lane_id: "stranded" }]);
  // A dry run reports and changes nothing.
  expect(await laneRows()).toEqual([
    { lane_id: "finished", status: "completed", attempt_count: 0 },
    { lane_id: "queued", status: "pending", attempt_count: 0 },
    { lane_id: "stranded", status: "running", attempt_count: 1 },
  ]);

  expect(await reclaimStrandedLanes(false, false)).toEqual([{ lane_id: "stranded" }]);
  expect(await laneRows()).toEqual([
    { lane_id: "finished", status: "completed", attempt_count: 0 },
    { lane_id: "queued", status: "pending", attempt_count: 0 },
    // attempt_count survives: the lane never got the attempt the machine took
    // from it, so charging it one walks it towards the retry ceiling for free.
    { lane_id: "stranded", status: "pending", attempt_count: 1 },
  ]);

  // Idempotent, which is what makes it safe to print in the installer's output
  // as the thing to run after any unclean stop.
  expect(await reclaimStrandedLanes(false, false)).toEqual([]);
});

test("--failed retries a failed lane from a clean attempt count, and --lane scopes it", async () => {
  await insertLane("broke", "failed", 3);
  await insertLane("also-broke", "failed", 2);
  await insertLane("stranded", "running", 1);

  // A failed lane is not stranded, so the default pass must leave it alone.
  expect(await reclaimStrandedLanes(false, false)).toEqual([{ lane_id: "stranded" }]);

  expect(await reclaimStrandedLanes(false, true, "broke")).toEqual([{ lane_id: "broke" }]);
  expect(await laneRows()).toEqual([
    { lane_id: "also-broke", status: "failed", attempt_count: 2 },
    { lane_id: "broke", status: "pending", attempt_count: 0 },
    { lane_id: "stranded", status: "pending", attempt_count: 1 },
  ]);
});

test("reset-stranded fails a running construction run and leaves a closed run alone", async () => {
  await sql`INSERT INTO plans (plan_id, title) VALUES ('stranded-plan', 'Stranded Plan')`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES ('stranded-plan', 1, ${{ objective: "test" }}) RETURNING id
  `;
  const [running] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    VALUES (${revision.id}, 'construction', 1, 'running') RETURNING id
  `;
  const [closed] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status, detail, finished_at)
    VALUES (${revision.id}, 'construction', 2, 'failed', ${{ message: "original" }}, now())
    RETURNING id, detail, finished_at
  `;

  expect(await reclaimStrandedConstructionRuns(false)).toEqual([{ id: running.id }]);

  const rows = await sql`
    SELECT id, status, detail, finished_at FROM verification_runs
    WHERE layer = 'construction'
    ORDER BY attempt
  `;
  expect(rows[0]).toMatchObject({
    status: "failed",
    detail: {
      step: "reset-stranded",
      message: "Running construction attempt was reclaimed as stranded.",
    },
    finished_at: expect.any(Date),
  });
  expect(rows[1]).toMatchObject({
    id: closed.id,
    status: "failed",
    detail: { message: "original" },
    finished_at: closed.finished_at,
  });
  expect(await reclaimStrandedConstructionRuns(false)).toEqual([]);
});
