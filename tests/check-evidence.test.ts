import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "laneward-evidence-"));
  temporaryDirectories.push(dir);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.local"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: dir });
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core", "existing.ts"), "export {};\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function gitState(dir: string) {
  const value = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args]);
    return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
  };
  return { head: value(["rev-parse", "--verify", "HEAD"]), ref: value(["symbolic-ref", "-q", "HEAD"]) };
}

function runCheck(
  dir: string,
  laneType: string,
  ownedPaths: string[],
  options: { beforeState?: ReturnType<typeof gitState>; gitGuardLog?: string } = {},
) {
  const script = join(import.meta.dir, "..", "scripts", "check-evidence.ts");
  return Bun.spawnSync([
    process.execPath,
    script,
    ...(options.beforeState ? ["--before-state", JSON.stringify(options.beforeState)] : []),
    ...(options.gitGuardLog ? ["--git-guard-log", options.gitGuardLog] : []),
    dir,
    laneType,
    ...ownedPaths,
  ]);
}

test("write lane with no changes exits 2", () => {
  const dir = initRepo();
  const result = runCheck(dir, "write", ["core/*"]);
  expect(result.exitCode).toBe(2);
});

test("write lane with an in-scope change passes", () => {
  const dir = initRepo();
  writeFileSync(join(dir, "core", "new.ts"), "export const x = 1;\n");
  const result = runCheck(dir, "write", ["core/*"]);
  expect(result.exitCode).toBe(0);
});

test("write lane with an out-of-scope change exits 1", () => {
  const dir = initRepo();
  mkdirSync(join(dir, "web"), { recursive: true });
  writeFileSync(join(dir, "web", "new.ts"), "export const x = 1;\n");
  const result = runCheck(dir, "write", ["core/*"]);
  expect(result.exitCode).toBe(1);
});

test("read_review lane with no changes passes", () => {
  const dir = initRepo();
  const result = runCheck(dir, "read_review", ["core/*"]);
  expect(result.exitCode).toBe(0);
});

test("read_review lane with an out-of-scope change still fails", () => {
  const dir = initRepo();
  mkdirSync(join(dir, "web"), { recursive: true });
  writeFileSync(join(dir, "web", "new.ts"), "export const x = 1;\n");
  const result = runCheck(dir, "read_review", ["core/*"]);
  expect(result.exitCode).toBe(1);
});

test("an out-of-scope file in a new directory is named, not its directory", () => {
  const dir = initRepo();
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "style.css"), "body{}\n");
  const result = runCheck(dir, "write", ["core/*"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("assets/style.css");
});

test("handles a worktree path containing spaces", () => {
  const dir = initRepo();
  const spaced = `${dir} with spaces`;
  temporaryDirectories.push(spaced);
  Bun.spawnSync(["git", "clone", "-q", dir, spaced]);
  writeFileSync(join(spaced, "core", "new.ts"), "export const x = 1;\n");

  expect(runCheck(spaced, "write", ["core/*"]).exitCode).toBe(0);
});

test("a moved HEAD is a Git boundary violation, not an empty write lane", () => {
  const dir = initRepo();
  const beforeState = gitState(dir);
  writeFileSync(join(dir, "core", "existing.ts"), "export const changed = true;\n");
  Bun.spawnSync(["git", "add", "core/existing.ts"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-q", "-m", "moved head"], { cwd: dir });

  const result = runCheck(dir, "write", ["core/*"], { beforeState });

  expect(result.exitCode).toBe(3);
  expect(result.stderr.toString()).toContain("Git boundary violation: HEAD changed");
  expect(result.stderr.toString()).not.toContain("write lane produced no changes");
});

test("a non-empty guard log is a Git boundary violation", () => {
  const dir = initRepo();
  const logPath = join(dir, "git-guard.jsonl");
  writeFileSync(logPath, '{"argv":["commit"]}\n');

  const result = runCheck(dir, "write", ["core/*"], { beforeState: gitState(dir), gitGuardLog: logPath });

  expect(result.exitCode).toBe(3);
  expect(result.stderr.toString()).toContain("git guard recorded a refusal");
});
