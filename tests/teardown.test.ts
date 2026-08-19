import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

  return { root, repo, git, worktree: join(worktrees, laneId), teardown };
}

test("a clean, integrated lane is removed whole", async () => {
  const { root, repo, worktree, teardown } = await fixture();

  const result = teardown();
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(existsSync(worktree)).toBe(false);

  const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", `lane/${laneId}`], { stdout: "pipe" });
  expect(new TextDecoder().decode(branches.stdout).trim()).toBe("");

  await rm(root, { recursive: true, force: true });
});

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
  expect(existsSync(worktree)).toBe(false);
  const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", `lane/${laneId}`], { stdout: "pipe" });
  expect(new TextDecoder().decode(branches.stdout).trim()).toBe("");

  await rm(root, { recursive: true, force: true });
});

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
