import { appendFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export const GIT_GUARD_REFUSAL_EXIT = 86;

const READ_ONLY_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "describe",
  "grep",
  "show-ref",
  "for-each-ref",
  "merge-base",
  "diff-tree",
  "diff-index",
  "shortlog",
  "name-rev",
]);

function envPath(env: Record<string, string | undefined>): string {
  return Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
}

function commandAfter(args: string[], index: number): string {
  for (let i = index; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) return arg;
    if (["-c", "--config-env", "-C", "--git-dir", "--work-tree", "--exec-path", "--upload-pack", "--receive-pack", "--namespace"].includes(arg)) i++;
  }
  return "(no subcommand)";
}

function recordRefusal(argv: string[]): void {
  const logPath = process.env.LANEWARD_GIT_GUARD_LOG;
  if (!logPath) return;

  try {
    appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), argv })}\n`);
  } catch {
    // Evidence must not turn a denied command into an unavailable guard.
  }
}

function refuse(subcommand: string, argv: string[]): never {
  recordRefusal(argv);
  console.error(`REFUSED: git ${subcommand} is not permitted. Laneward owns Git.`);
  process.exit(GIT_GUARD_REFUSAL_EXIT);
}

function isPureListing(subcommand: string, args: string[]): boolean {
  if (subcommand === "worktree" || subcommand === "stash") return args[0] === "list";

  const noValue = new Set([
    "-a",
    "--all",
    "-r",
    "--remotes",
    "-v",
    "-vv",
    "--verbose",
    "--list",
    "--show-current",
    "--no-color",
    "--no-column",
  ]);
  const withValue = new Set([
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
    "--sort",
    "--format",
    "--color",
    "--column",
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (noValue.has(arg) || arg.startsWith("--color=") || arg.startsWith("--column=")) continue;
    if (withValue.has(arg)) {
      if (!args[++i]) return false;
      continue;
    }
    if (["--contains=", "--no-contains=", "--merged=", "--no-merged=", "--points-at=", "--sort=", "--format="].some((prefix) => arg.startsWith(prefix))) continue;
    return false;
  }
  return true;
}

export function permittedSubcommand(argv: string[]): string | null {
  if (argv.length === 1 && argv[0] === "--version") return "--version";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      arg === "-c" ||
      arg.startsWith("-c") ||
      ["--config-env", "--exec-path", "--upload-pack", "--receive-pack", "--namespace"].some(
        (option) => arg === option || arg.startsWith(`${option}=`),
      )
    ) {
      return null;
    }
    if (!arg.startsWith("-") || arg === "-") {
      if (arg === "branch" || arg === "worktree" || arg === "stash") return isPureListing(arg, argv.slice(i + 1)) ? arg : null;
      return READ_ONLY_COMMANDS.has(arg) ? arg : null;
    }

    if (arg === "--no-pager" || arg === "--paginate") continue;
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      if (!argv[++i]) return null;
      continue;
    }
    if (arg.startsWith("-C") || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) continue;
    return null;
  }
  return null;
}

// The shim lives in scripts/git-shim/, one level below this file. Deriving the
// directory to strip from dirname(import.meta.path) yields scripts/, which is
// never on PATH, so the shim survived the filter and the guard resolved itself.
// On Windows that surfaced as "The system cannot execute the specified program"
// rather than as recursion, because Bun cannot exec a .cmd directly.
const SHIM_DIR = join(dirname(import.meta.path), "git-shim");

export function resolveRealGit(env: Record<string, string | undefined> = process.env): string | null {
  if (env.LANEWARD_REAL_GIT) return env.LANEWARD_REAL_GIT;

  const shimDir = resolve(SHIM_DIR).toLowerCase();
  const cleanPath = envPath(env)
    .split(delimiter)
    .filter((entry) => entry && resolve(entry).toLowerCase() !== shimDir)
    .join(delimiter);
  const git = Bun.which("git", { PATH: cleanPath });

  // Refuse rather than exec anything that still resolves inside the shim: a
  // guard that invokes itself is not a guard.
  if (!git || dirname(resolve(git)).toLowerCase() === shimDir) return null;
  return git;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const subcommand = permittedSubcommand(argv);
  if (!subcommand) refuse(commandAfter(argv, 0), argv);

  const git = resolveRealGit();
  if (!git) {
    recordRefusal(argv);
    console.error("REFUSED: real git could not be resolved. Laneward owns Git.");
    process.exit(GIT_GUARD_REFUSAL_EXIT);
  }

  const result = Bun.spawnSync([git, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(result.exitCode ?? 1);
}
