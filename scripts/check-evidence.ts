import { existsSync, readFileSync } from "node:fs";

interface GitState {
  head: string | null;
  ref: string | null;
}

const args = process.argv.slice(2);
let beforeState: GitState | undefined;
let gitGuardLog: string | undefined;

while (args[0]?.startsWith("--")) {
  const flag = args.shift();
  const value = args.shift();
  if (!value) {
    console.error(`FAIL: missing value for ${flag}`);
    process.exit(1);
  }
  if (flag === "--before-state") {
    try {
      const parsed = JSON.parse(value) as GitState;
      if (![parsed.head, parsed.ref].every((part) => part === null || typeof part === "string")) throw new Error();
      beforeState = parsed;
    } catch {
      console.error("FAIL: invalid --before-state");
      process.exit(1);
    }
  } else if (flag === "--git-guard-log") {
    gitGuardLog = value;
  } else {
    console.error(`FAIL: unknown option ${flag}`);
    process.exit(1);
  }
}

const [worktree, laneType, ...ownedPaths] = args;

const status = Bun.spawnSync(["git", "-C", worktree, "status", "--porcelain", "-uall"]);
const changed = new TextDecoder()
  .decode(status.stdout)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    // ponytail: assumes standard 2-char status + space prefix; does not
    // special-case rename entries ("R  old -> new"), upgrade if that shows up.
    return line.slice(3);
    // -uall: without it git collapses a new directory into one "dir/" entry, so the
    // report names a directory the operator then has to go and inspect by hand.
  });

function gitValue(args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", worktree, ...args]);
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() || null : null;
}

const gitBoundaryViolations: string[] = [];
if (beforeState) {
  const afterState = {
    head: gitValue(["rev-parse", "--verify", "HEAD"]),
    ref: gitValue(["symbolic-ref", "-q", "HEAD"]),
  };
  if (afterState.head !== beforeState.head) gitBoundaryViolations.push("HEAD changed");
  if (afterState.ref !== beforeState.ref) gitBoundaryViolations.push("checked-out ref changed");
}

const staged = Bun.spawnSync(["git", "-C", worktree, "diff", "--cached", "--quiet"]);
if (staged.exitCode === 1) gitBoundaryViolations.push("index has staged entries");

if (gitGuardLog && existsSync(gitGuardLog) && readFileSync(gitGuardLog, "utf8").trim()) {
  gitBoundaryViolations.push("git guard recorded a refusal");
}

if (gitBoundaryViolations.length > 0) {
  console.error(`FAIL: Git boundary violation: ${gitBoundaryViolations.join(", ")}`);
  process.exit(3);
}

function matches(path: string, pattern: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1 || end === i + 1) source += "\\[";
      else {
        const group = pattern.slice(i + 1, end);
        source += `[${group[0] === "!" ? "^" : ""}${group.slice(group[0] === "!" ? 1 : 0)}]`;
        i = end;
      }
    } else source += /[\\^$+?.()|{}]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`).test(path);
}

if (laneType === "write" && changed.length === 0) {
  console.error("FAIL: write lane produced no changes");
  process.exit(2);
}

const violations = changed.filter((path) => !ownedPaths.some((pattern) => matches(path, pattern)));
if (violations.length > 0) {
  console.error(`FAIL: ownership violation: ${violations.join(" ")}`);
  process.exit(1);
}

console.log(`PASS: ${changed.length} changed path(s), all within owned_paths`);
