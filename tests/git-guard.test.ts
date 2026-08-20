import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const GUARD = join(import.meta.dir, "..", "scripts", "git-guard.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "laneward-git-guard-"));
  temporaryDirectories.push(dir);
  Bun.spawnSync(["git", "init", "-q", dir]);
  Bun.spawnSync(["git", "config", "user.email", "test@test.local"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "needle\n-case\n");
  Bun.spawnSync(["git", "add", "file.txt"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function runGuard(dir: string, args: string[], logPath?: string) {
  return Bun.spawnSync([process.execPath, GUARD, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      LANEWARD_REAL_GIT: Bun.which("git")!,
      ...(logPath ? { LANEWARD_GIT_GUARD_LOG: logPath } : {}),
    },
  });
}

for (const args of [
  [],
  ["add", "file.txt"],
  ["commit", "-m", "x"],
  ["push"],
  ["merge", "main"],
  ["rebase", "HEAD"],
  ["reset", "--hard"],
  ["checkout", "HEAD"],
  ["switch", "main"],
  ["worktree"],
  ["worktree", "add", "../other"],
  ["worktree", "remove", "../other"],
  ["worktree", "prune"],
  ["stash"],
  ["stash", "push"],
  ["stash", "pop"],
  ["stash", "drop"],
  ["stash", "clear"],
  ["tag", "v1"],
  ["update-ref", "refs/heads/x", "HEAD"],
  ["config", "user.name"],
  ["branch", "new-branch"],
  ["-c", "core.pager=cat", "status"],
  ["-c", "core.pager=x", "worktree", "list"],
  ["unknown-subcommand"],
]) {
  test(`refuses git ${args.join(" ")}`, () => {
    const result = runGuard(initRepo(), args);
    expect(result.exitCode).toBe(86);
    expect(result.stderr.toString()).toContain("REFUSED:");
    expect(result.stderr.toString()).toContain("Laneward owns Git");
  });
}

test("permits every allowlisted read command and a branch listing", () => {
  const dir = initRepo();
  for (const args of [
    ["--version"],
    ["status"],
    ["diff"],
    ["log", "-1"],
    ["log", "--oneline", "-1", "--", "-config.txt"],
    ["show", "--stat", "--oneline", "HEAD"],
    ["rev-parse", "HEAD"],
    ["rev-list", "--count", "HEAD"],
    ["ls-files"],
    ["ls-tree", "HEAD"],
    ["cat-file", "-t", "HEAD"],
    ["blame", "file.txt"],
    ["describe", "--always"],
    ["grep", "needle"],
    ["grep", "-e", "-case"],
    ["show-ref"],
    ["for-each-ref"],
    ["merge-base", "HEAD", "HEAD"],
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    ["diff-index", "HEAD"],
    ["shortlog", "HEAD"],
    ["name-rev", "HEAD"],
    ["branch"],
    ["worktree", "list"],
    ["worktree", "list", "--porcelain"],
    ["stash", "list"],
    ["-C", dir, "status"],
  ]) {
    expect(runGuard(dir, args).exitCode).toBe(0);
  }
});

// Every other test here injects LANEWARD_REAL_GIT, which is exactly how the
// guard's own fallback stayed broken while the suite was green: it resolved the
// shim instead of git, and a permitted command died with an exec error. The
// conductor always sets the variable, so only standalone use hit it. This test
// removes the variable and puts the shim on PATH, which is the arrangement the
// fallback exists for.
test("resolves the real git without LANEWARD_REAL_GIT while the shim is on PATH", () => {
  const dir = initRepo();
  const shimDir = join(import.meta.dir, "..", "scripts", "git-shim");
  // Windows spells it "Path". Copying process.env and then assigning "PATH"
  // leaves both keys in the object, and the child process gets whichever one
  // the platform decides wins. Drop the existing key instead of shadowing it.
  const env: Record<string, string> = {};
  let inheritedPath = "";
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.toUpperCase() === "LANEWARD_REAL_GIT") continue;
    if (key.toUpperCase() === "PATH") {
      inheritedPath = value;
      continue;
    }
    env[key] = value;
  }
  env.PATH = `${shimDir}${delimiter}${inheritedPath}`;

  const permitted = Bun.spawnSync([process.execPath, GUARD, "rev-parse", "HEAD"], { cwd: dir, env });
  expect(permitted.stderr.toString()).not.toContain("real git could not be resolved");
  expect(permitted.exitCode).toBe(0);

  const refused = Bun.spawnSync([process.execPath, GUARD, "commit", "-m", "x"], { cwd: dir, env });
  expect(refused.exitCode).toBe(86);
});

test("records a refused argv in the configured guard log", () => {
  const dir = initRepo();
  const logPath = join(dir, "git-guard.jsonl");

  expect(runGuard(dir, ["commit", "--allow-empty", "-m", "x"], logPath).exitCode).toBe(86);

  return Bun.file(logPath).text().then((text) => {
    const [entry] = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(entry.argv).toEqual(["commit", "--allow-empty", "-m", "x"]);
    expect(entry.timestamp).toBeString();
    expect(entry.read_intent).toBe(false);
  });
});

test("records read_intent true for a refused read hidden behind -c", () => {
  const dir = initRepo();
  const logPath = join(dir, "git-guard.jsonl");

  expect(runGuard(dir, ["-c", "core.pager=cat", "status", "--short"], logPath).exitCode).toBe(86);

  return Bun.file(logPath).text().then((text) => {
    const [entry] = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(entry.read_intent).toBe(true);
  });
});

test("records read_intent false for a refused branch mutation", () => {
  const dir = initRepo();
  const logPath = join(dir, "git-guard.jsonl");

  expect(runGuard(dir, ["branch", "-D", "some-branch"], logPath).exitCode).toBe(86);

  return Bun.file(logPath).text().then((text) => {
    const [entry] = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(entry.read_intent).toBe(false);
  });
});
