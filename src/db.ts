import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set: copy .env.example to .env");
}

/**
 * Every test file in this repository truncates `lanes`, `messages` and
 * `approvals` in whatever database `DATABASE_URL` names, so a suite run pointed
 * at the live hub destroys real rows. That has happened repeatedly, and the
 * defences against it were scattered: `--no-env-file` on the conductor,
 * `DATABASE_URL: undefined` in the lane-check spawn, a paragraph in every lane
 * brief. Each one guards a single caller, and a caller nobody thought of is how
 * the accident keeps recurring.
 *
 * This module is the one place all of them route through, so the refusal lives
 * here instead. Under `bun test`, which sets NODE_ENV=test, a database whose
 * name is not recognisably disposable is rejected before the first statement
 * runs.
 *
 * Disposable means `laneward_test`, any name ending in `_test`, or a
 * `laneward_lane_*` database provisioned per lane by `scripts/new-lane.ts`.
 */
export function isDisposableDatabase(databaseUrl: string): boolean {
  let name: string;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
  return name.endsWith("_test") || name.startsWith("laneward_lane_");
}

if (process.env.NODE_ENV === "test" && !isDisposableDatabase(url)) {
  throw new Error(
    `refusing to run tests against ${new URL(url).pathname.replace(/^\//, "") || "an unnamed database"}: ` +
      "the suite truncates lanes, messages and approvals. Point DATABASE_URL at " +
      "laneward_test, a name ending in _test, or a laneward_lane_* database.",
  );
}

export const sql = new SQL(url);
