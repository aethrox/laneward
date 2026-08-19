import { statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const timeout = 2_000;

function url(path: string) {
  const hubUrl = process.env.HUB_URL ?? "http://127.0.0.1:8787";
  return new URL(path, hubUrl.endsWith("/") ? hubUrl : `${hubUrl}/`);
}

async function hubJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url(path), { ...init, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`hub returned HTTP ${response.status}`);
  return await response.json();
}

type HookPayload = { cwd?: unknown; hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown };

async function hookPayload(input: () => Promise<string>): Promise<HookPayload> {
  try {
    const payload = JSON.parse(await input());
    if (!payload || typeof payload !== "object") throw new Error();
    return payload;
  } catch {
    throw new Error("invalid hook payload");
  }
}

function laneForCwd(cwd: unknown, lanes: unknown): string | undefined {
  if (typeof cwd !== "string" || !Array.isArray(lanes)) throw new Error("invalid lane list or cwd");
  const current = resolve(cwd).toLowerCase();
  for (const lane of lanes) {
    if (!lane || typeof lane !== "object") throw new Error("malformed lane response");
    const { lane_id, worktree_path } = lane as { lane_id?: unknown; worktree_path?: unknown };
    const path = typeof worktree_path === "string" ? resolve(worktree_path).toLowerCase() : undefined;
    if (typeof lane_id === "string" && path && (current === path || current.startsWith(`${path}${sep}`))) return lane_id;
  }
  return undefined;
}

// A lane always runs in a linked worktree, where `.git` is a file pointing at
// the main checkout; the main checkout's `.git` is a directory. Answering this
// from the filesystem, before any HTTP, is what keeps a hub outage from denying
// every tool call in the main checkout: failing closed only has to apply where
// a lane could actually be. A lane cannot escape by deleting the marker either,
// because deleting `.git` is what stops it from being a worktree at all.
function inLinkedWorktree(cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    try {
      return !statSync(join(dir, ".git")).isDirectory();
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

// The gate exists to stop a lane from *changing* things it has no approval for.
// A `Bash` matcher cannot express that on its own, since it matches the tool
// rather than the command, so the command is read here. Denying `git status` buys nothing and
// costs the worker the one thing that tells it why it is stuck.
//
// This is an allowlist: an unrecognized command is gated. Shell metacharacters
// disqualify the whole line, because `git log && rm -rf .` opens with a
// read-only prefix and any weaker check reads it as read-only.
const readOnly = /^\s*(?:git\s+(?:status|log|diff|show|branch|blame|remote|describe|rev-parse|worktree\s+list)|ls|pwd|cat|head|tail|wc|grep|rg|find|stat|file|which|whoami|date|echo)\b/;

function readOnlyBash(payload: HookPayload): boolean {
  if (payload.tool_name !== "Bash") return false;
  const command = (payload.tool_input as { command?: unknown } | undefined)?.command;
  if (typeof command !== "string" || /[;&|<>`$(){}\n]/.test(command)) return false;
  return readOnly.test(command);
}

function deny(event: unknown, reason: string, write: (text: string) => void, report: (text: string) => void) {
  report(`Laneward gate denied: ${reason}`);
  if (event === "PreToolUse") {
    write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
    } }));
  }
  return 2;
}

async function gate(input: () => Promise<string>, write: (text: string) => void, report: (text: string) => void) {
  // Undefined until hookPayload returns: the catch below runs on a malformed
  // payload too, and it reads this.
  let payload: HookPayload | undefined;
  try {
    payload = await hookPayload(input);
    if (typeof payload.cwd === "string" && !inLinkedWorktree(payload.cwd)) return 0;
    if (readOnlyBash(payload)) return 0;
    const lanes = await hubJson("/lanes");
    const laneId = laneForCwd(payload.cwd, lanes);
    if (!laneId) return 0;
    const result = await hubJson(`/lanes/${encodeURIComponent(laneId)}/gate`);
    if (!result || typeof result !== "object" || typeof (result as { allowed?: unknown }).allowed !== "boolean") {
      throw new Error("malformed gate response");
    }
    if (!(result as { allowed: boolean }).allowed) {
      return deny(payload.hook_event_name, typeof (result as { reason?: unknown }).reason === "string" ? (result as { reason: string }).reason : "gate closed", write, report);
    }
    return 0;
  } catch (error) {
    return deny(payload?.hook_event_name, error instanceof Error ? error.message : "hub unavailable", write, report);
  }
}

async function state(write: (text: string) => void) {
  try {
    const [pending, lanes] = await Promise.all([hubJson("/pending"), hubJson("/lanes")]);
    if (!pending || typeof pending !== "object" || !Array.isArray(lanes)) throw new Error("malformed hub response");
    const data = pending as Record<string, unknown>;
    const count = (key: string) => Array.isArray(data[key]) ? data[key].length : 0;
    // A lane naming a revision the operator never approved is stuck: checkGate
    // refuses it, and nothing in /pending reports it because the lane never got
    // far enough to raise an approval request.
    const unapproved = lanes.filter((lane) => lane?.plan_revision_id && !lane.approved_at).length;
    const context = `Laneward: ${unapproved} lane(s) blocked on an unapproved plan revision; ${count("waiting_approval")} lane(s) waiting on a human; ${count("failed")} failed lane(s).`;
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  } catch {
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Laneward is unreachable; gate status is unavailable." } }));
  }
  return 0;
}

async function submit(args: string[], write: (text: string) => void) {
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const title = flag("--title");
  const contentFile = flag("--content");
  if (!title || !contentFile) throw new Error("Usage: bridge plan submit --title <title> --content <file.json> [--id <plan_id>]");
  const content = JSON.parse(await Bun.file(contentFile).text());
  // A generated id is unaddressable: POST /plans/:id/revisions needs one the
  // operator can type, so a plan meant to gain revisions gets a real name.
  const planId = flag("--id") ?? crypto.randomUUID();
  const body = await hubJson("/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan_id: planId, title, content }) }) as { plan_id?: unknown; revision_id?: unknown };
  if (typeof body.plan_id !== "string" || typeof body.revision_id !== "string") throw new Error("malformed plan response");
  write(`Plan: ${body.plan_id}\nRevision: ${body.revision_id}`);
}

async function createLane(args: string[]) {
  if (args.length < 3) throw new Error("Usage: bridge lane create <lane_id> <brief-file> <owned_path>...");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./new-lane.ts", import.meta.url)), ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  return await child.exited;
}

export async function main(
  args: string[],
  input = () => Bun.stdin.text(),
  write = (text: string) => console.log(text),
  report = (text: string) => console.error(text),
) {
  args = [...args];
  const command = args.shift();
  const run = command === "state" && args.length === 0 ? state(write)
    : command === "gate" && args.length === 0 ? gate(input, write, report)
    : command === "plan" && args.shift() === "submit" ? submit(args, write).then(() => 0)
    : command === "lane" && args.shift() === "create" ? createLane(args)
    : Promise.reject(new Error("Usage: bridge <state|gate|plan submit|lane create>"));
  return await run;
}

if (import.meta.main) {
  void main(process.argv.slice(2)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; },
  );
}
