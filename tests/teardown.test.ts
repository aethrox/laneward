import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { laneDatabaseName } from "../scripts/teardown";

const laneId = "teardown-test";

// A lane whose provisioning never ran still carries the .env it was copied
// from, and that one names the hub's database. Teardown reading it literally
// would drop the hub.
test("only a database this lane could have created is named for removal", () => {
  const hub = "postgres://u:p@127.0.0.1:5433/laneward";
  expect(laneDatabaseName(`DATABASE_URL=${hub}\n`, laneId)).toBeUndefined();
  expect(laneDatabaseName(`DATABASE_URL=${hub}_lane_teardown_test\n`, laneId)).toBe(
    "laneward_lane_teardown_test",
  );
  // Another lane's database is not this lane's to drop either.
  expect(laneDatabaseName(`DATABASE_URL=${hub}_lane_other\n`, laneId)).toBeUndefined();
  expect(laneDatabaseName("API_PORT=4390\n", laneId)).toBeUndefined();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "laneward-teardown-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

  Bun.spawnSync(["git", "init", "-q", repo]);
  git("config", "user.email", "test@test.local");
  git("config", "user.name", "test");
  await Bun.write(join(repo, "tracked.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", `lane/${laneId}`, join(worktrees, laneId));

  const teardown = () =>
    Bun.spawnSync(["bun", "run", join(import.meta.dir, "../scripts/teardown.ts"), laneId], {
      env: { ...process.env, LANE_REPO: repo, LANE_WORKTREE_ROOT: worktrees },
      stdout: "pipe",
      stderr: "pipe",
    });

  // `laneLocation` resolves LANE_WORKTREE_ROOT through `realpath`, and both
  // `new-lane` and `teardown` reach a worktree that way. The fixture creates
  // one directly, so it has to look at the directory teardown will look at
  // rather than the spelling it passed in: on a machine whose temp directory is
  // reached through a link or an 8.3 short name those are different strings.
  const worktree = join(await realpath(worktrees), laneId);

  return { root, repo, git, worktree, teardown };
}

/**
 * Waits for the worktree directory to go, and reports what teardown believed it
 * did when it does not.
 *
 * The wait covers a Windows directory that is delete-pending, still visible
 * until the last handle on it closes. On the GitHub Windows runner it does not
 * help: the directory is still there after the full budget, while teardown
 * exits 0 with nothing on stderr, which means its own existence check found the
 * path gone. Two processes disagreeing about one path is what the reported
 * stdout is here to pin down.
 *
 * The caller has to allow more than `timeoutMs`. A test left on Bun's 5000ms
 * default cannot outlast a 5000ms wait, so this message was never the one CI
 * printed: it reported an opaque test timeout instead, twice.
 */
async function removalOf(worktree: string, said = "", timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(worktree)) {
    if (Date.now() >= deadline) {
      return `still there after ${timeoutMs}ms: ${worktree}\nteardown said: ${said.trim()}`;
    }
    await Bun.sleep(25);
  }
  return "removed";
}

test("a clean, integrated lane is removed whole", async () => {
  const { root, repo, worktree, teardown } = await fixture();

  const result = teardown();
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(await removalOf(worktree, new TextDecoder().decode(result.stdout))).toBe("removed");

  const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", `lane/${laneId}`], { stdout: "pipe" });
  expect(new TextDecoder().decode(branches.stdout).trim()).toBe("");

  await rm(root, { recursive: true, force: true });
}, 20_000);

test("an uncommitted change stops teardown and removes nothing", async () => {
  const { root, worktree, teardown } = await fixture();
  await Bun.write(join(worktree, "evidence.txt"), "the thing nobody wrote down\n");

  const result = teardown();
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("evidence.txt");
  expect(existsSync(worktree)).toBe(true);

  await rm(root, { recursive: true, force: true });
});

// `git cherry` accepts a cherry-picked lane as integrated; `git branch -d`
// rejects it, because it asks about ancestry instead. Deleting with `-d` put
// that disagreement after the removals, so the lane tore down halfway: worktree
// and database gone, branch left behind, and the command could not be re-run.
test("a lane integrated by cherry-pick tears down completely", async () => {
  const { root, repo, git, worktree, teardown } = await fixture();
  const lane = (...args: string[]) => Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  await Bun.write(join(worktree, "work.txt"), "done\n");
  lane("add", "-A");
  lane("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "lane work");
  // Master moves on, then takes the lane's patch under a different hash.
  await Bun.write(join(repo, "tracked.txt"), "two\n");
  git("commit", "-qam", "master moves");
  git("cherry-pick", `lane/${laneId}`);

  const result = teardown();
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(await removalOf(worktree, new TextDecoder().decode(result.stdout))).toBe("removed");
  const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", `lane/${laneId}`], { stdout: "pipe" });
  expect(new TextDecoder().decode(branches.stdout).trim()).toBe("");

  await rm(root, { recursive: true, force: true });
}, 20_000);

// A worktree whose branch was deleted or moved by hand sits on a detached HEAD.
// `git cherry` then exits 128, and reading that as "nothing unintegrated"
// removed a worktree holding the only copy of a commit.
test("a git failure in the integration check stops teardown", async () => {
  const { root, repo, worktree, teardown } = await fixture();
  const lane = (...args: string[]) => Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  lane("checkout", "-q", "--detach");
  Bun.spawnSync(["git", "-C", repo, "branch", "-D", `lane/${laneId}`], { stdout: "pipe", stderr: "pipe" });
  await Bun.write(join(worktree, "only-copy.txt"), "the sole record of this work\n");
  lane("add", "-A");
  lane("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work only this worktree holds");

  const result = teardown();
  expect(result.exitCode).toBe(1);
  expect(existsSync(worktree)).toBe(true);

  await rm(root, { recursive: true, force: true });
});

test("a commit the repository does not carry stops teardown", async () => {
  const { root, worktree, teardown } = await fixture();
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  await Bun.write(join(worktree, "work.txt"), "done\n");
  git("add", "-A");
  git("commit", "-q", "-m", "lane work nobody merged");

  const result = teardown();
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("lane work nobody merged");
  expect(existsSync(worktree)).toBe(true);

  await rm(root, { recursive: true, force: true });
});
