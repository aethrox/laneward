import { sql } from "../src/db";

const reclaimedDetail = {
  step: "reset-stranded",
  message: "Running construction attempt was reclaimed as stranded.",
};

export async function reclaimStrandedConstructionRuns(dryRun: boolean) {
  return dryRun
    ? sql`
        SELECT id FROM verification_runs
        WHERE layer = 'construction' AND status = 'running'
        ORDER BY started_at, id
      `
    : sql`
        UPDATE verification_runs
        SET status = 'failed', detail = ${reclaimedDetail}, finished_at = now()
        WHERE layer = 'construction' AND status = 'running'
        RETURNING id
      `;
}

/**
 * `running` is the stranded case: a reboot or a kill left the row claimed with
 * no worker behind it. `failed` is the retry case: the lane really did run and
 * really did fail, and an operator who has since fixed the cause needs a
 * supported way to send it round again rather than editing the row by hand.
 *
 * Only the retry case clears `attempt_count`. A stranded lane never got its
 * attempt, so charging it one would walk it towards the retry ceiling for
 * something the machine did.
 *
 * Extracted from `main` so the behaviour can be asserted. On Windows this is the
 * whole recovery mechanism rather than a fallback: stopping the Scheduled Task
 * terminates the conductor with no catchable signal, so lanes are left `running`
 * with no worker behind them and nothing else brings them back (D-038, CP-3).
 */
export async function reclaimStrandedLanes(
  dryRun: boolean,
  retryFailed: boolean,
  laneId?: string,
) {
  const status = retryFailed ? "failed" : "running";
  return dryRun
    ? sql`
        SELECT lane_id FROM lanes
        WHERE status = ${status} AND (${laneId ?? null}::text IS NULL OR lane_id = ${laneId ?? null})
      `
    : sql`
        UPDATE lanes
        SET status = 'pending',
            attempt_count = CASE WHEN ${retryFailed} THEN 0 ELSE attempt_count END
        WHERE status = ${status} AND (${laneId ?? null}::text IS NULL OR lane_id = ${laneId ?? null})
        RETURNING lane_id
      `;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const retryFailed = process.argv.includes("--failed");
  const laneFlag = process.argv.indexOf("--lane");
  const laneId = laneFlag === -1 ? undefined : process.argv[laneFlag + 1];
  if (laneFlag !== -1 && !laneId) {
    console.error("Usage: scripts/reset-stranded.ts [--dry-run] [--failed] [--lane <lane_id>]");
    return 2;
  }

  const label = retryFailed ? "failed" : "stranded";
  const lanes = await reclaimStrandedLanes(dryRun, retryFailed, laneId);

  if (lanes.length === 0) {
    console.log(`No ${label} lanes found; nothing changed.`);
  } else {
    console.log(`${dryRun ? "Would reset" : "Reset"} ${lanes.length} ${label} lane(s) to pending:`);
    for (const lane of lanes) console.log(lane.lane_id);
  }

  if (!retryFailed && laneId === undefined) {
    const runs = await reclaimStrandedConstructionRuns(dryRun);
    if (runs.length === 0) {
      console.log("No stranded construction runs found; nothing changed.");
    } else {
      console.log(`${dryRun ? "Would fail" : "Failed"} ${runs.length} stranded construction run(s):`);
      for (const run of runs) console.log(run.id);
    }
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
