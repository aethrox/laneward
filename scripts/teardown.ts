import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { isSlug, slugRule } from "../src/slug";
import {
  dirtyPaths,
  dropLaneDatabase,
  envDatabaseUrl,
  laneDbSuffix,
  laneLocation,
  run,
} from "./new-lane";

const usage = "Usage: scripts/teardown.ts <lane_id>";

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}

/**
 * The lane's own database, read from the `.env` that `provisionLaneDatabase`
 * rewrote inside the worktree.
 *
 * The suffix check is the whole point. A lane whose provisioning never ran, or
 * ran against a repository that names no database, still carries a `.env` that
 * points at the database it was copied from, which is the hub's. Dropping
 * whatever that file names would destroy the hub. Only a name this lane id
 * could have produced is ever removed.
 */
export function laneDatabaseName(envText: string, laneId: string): string | undefined {
  const url = envDatabaseUrl(envText);
  if (!url) return undefined;
  const name = decodeURIComponent(url.pathname.slice(1));
  return name.endsWith(laneDbSuffix(laneId)) ? name : undefined;
}

/**
 * Commits on the lane branch that no commit in the repository's checkout
 * carries. `git cherry` compares patches rather than hashes, so a lane whose
 * work was rebased or cherry-picked in reads as integrated, which is what an
 * operator means by the word.
 *
 * This is the only definition of "integrated" teardown has, so a `git cherry`
 * that fails throws. Returning an empty list there reads a missing branch or a
 * broken repository as "nothing left to lose", which is the reading that
 * removes a worktree holding the only copy of a commit.
 */
export function unintegratedCommits(repoRoot: string, branch: string): string[] {
  const cherry = run(["git", "-C", repoRoot, "cherry", "-v", "HEAD", branch]);
  if (cherry.exitCode !== 0) {
    throw new Error(cherry.stderr.trim() || `Could not compare ${branch} against HEAD`);
  }
  return cherry.stdout.split("\n").filter((line) => line.startsWith("+"));
}

async function main() {
  const laneId = process.argv[2];
  if (!laneId) {
    console.error(usage);
    process.exit(1);
  }
  if (!isSlug(laneId)) {
    console.error(`Invalid lane_id: ${laneId}`);
    console.error(`A lane_id names a worktree directory and a branch: ${slugRule}.`);
    process.exit(1);
  }

  const { repoRoot, worktreePath, branch } = await laneLocation(laneId);

  if (!(await exists(worktreePath))) {
    console.error(`No worktree at ${worktreePath}`);
    process.exit(1);
  }

  const dirty = dirtyPaths(worktreePath);
  const unintegrated = unintegratedCommits(repoRoot, branch);
  if (dirty.length > 0 || unintegrated.length > 0) {
    console.error(`Refusing to tear down ${laneId}. Nothing was removed.`);
    if (dirty.length > 0) {
      console.error(`\nUncommitted changes in ${worktreePath}:`);
      for (const path of dirty) console.error(`  ${path}`);
    }
    if (unintegrated.length > 0) {
      console.error(`\nCommits on ${branch} that ${repoRoot} does not carry:`);
      for (const line of unintegrated) console.error(`  ${line.slice(2)}`);
    }
    process.exit(1);
  }

  // The .env lives inside the worktree, so the database goes first. A lane that
  // outlives its database is recoverable by hand; a database whose name only
  // that .env knew is not.
  const laneEnv = join(worktreePath, ".env");
  const laneDb = await Bun.file(laneEnv)
    .text()
    .then((text) => laneDatabaseName(text, laneId))
    .catch(() => undefined);
  if (laneDb) {
    await dropLaneDatabase(laneEnv, laneDb);
    console.log(`Dropped database: ${laneDb}`);
  }

  const removed = run(["git", "-C", repoRoot, "worktree", "remove", worktreePath]);
  if (removed.exitCode !== 0) throw new Error(removed.stderr.trim() || "Could not remove worktree");

  // Git unregisters the worktree and then deletes the directory, and on Windows
  // the second half can fail while git still exits 0, warning on stderr that
  // nothing here reads. The lane is already known clean and integrated by this
  // point, so finish the deletion rather than print a removal that did not
  // happen. A directory that survives even this carries git's own words.
  if (await exists(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    if (await exists(worktreePath)) {
      throw new Error(
        removed.stderr.trim() || `Worktree directory survived removal: ${worktreePath}`,
      );
    }
  }
  console.log(`Removed worktree: ${worktreePath}`);

  // `-D`, not `-d`, because integration was already decided above and `-d` would
  // decide it a second time by a different rule. `-d` asks whether the branch is
  // an ancestor of HEAD, so it refuses a lane whose commits were rebased or
  // cherry-picked in, which `git cherry` correctly accepted. That disagreement
  // fires here, after the database and the worktree are already gone.
  const deleted = run(["git", "-C", repoRoot, "branch", "-D", branch]);
  if (deleted.exitCode !== 0) throw new Error(deleted.stderr.trim() || `Could not delete ${branch}`);
  console.log(`Deleted branch: ${branch}`);
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
