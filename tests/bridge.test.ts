import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/bridge";

const servers: ReturnType<typeof Bun.serve>[] = [];
const trees: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const tree of trees.splice(0)) await rm(tree, { recursive: true, force: true });
});

// The gate decides lane-ness from the filesystem, so its tests need the real
// shape: a linked worktree whose `.git` is a file, and a main checkout whose
// `.git` is a directory.
async function checkouts() {
  const root = join(tmpdir(), `bridge-wt-${crypto.randomUUID()}`);
  const lane = join(root, "lane-a");
  const mainCheckout = join(root, "main-checkout");
  await mkdir(lane, { recursive: true });
  await mkdir(join(mainCheckout, ".git"), { recursive: true });
  await Bun.write(join(lane, ".git"), `gitdir: ${join(mainCheckout, ".git", "worktrees", "lane-a")}\n`);
  trees.push(root);
  return { lane, mainCheckout };
}

async function run(args: string[], payload = "", hub?: string) {
  const previous = process.env.HUB_URL;
  process.env.HUB_URL = hub ?? "http://127.0.0.1:1";
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    return {
      exitCode: await main(args, async () => payload, (text) => stdout.push(text), (text) => stderr.push(text)),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    if (previous === undefined) delete process.env.HUB_URL;
    else process.env.HUB_URL = previous;
  }
}

function serve(closed = false, worktreePath = "C:/lane-a") {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/lanes") return Response.json([{ lane_id: "lane-a", worktree_path: worktreePath }]);
      if (path === "/lanes/lane-a/gate") return Response.json(closed ? { allowed: false, reason: "needs approval" } : { allowed: true, reason: "ok" });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server.url.href;
}

test("gate fails closed inside a worktree when the hub is unreachable", async () => {
  const { lane } = await checkouts();
  const result = await run(["gate"], JSON.stringify({ cwd: lane, hook_event_name: "PreToolUse" }));
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Laneward gate denied");
});

test("gate reports the hub's closed-gate reason", async () => {
  const { lane } = await checkouts();
  const result = await run(["gate"], JSON.stringify({ cwd: lane, hook_event_name: "PreToolUse" }), serve(true, lane));
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("needs approval");
});

test("gate allows a worktree that matches no known lane", async () => {
  const { lane, mainCheckout } = await checkouts();
  const result = await run(["gate"], JSON.stringify({ cwd: mainCheckout, hook_event_name: "PreToolUse" }), serve(false, lane));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
});

// A hub outage must not lock the main checkout: with PreToolUse wired to the
// mutating tools, denying there would deny every edit in the repository.
test("gate never contacts the hub outside a linked worktree", async () => {
  const { mainCheckout } = await checkouts();
  const result = await run(["gate"], JSON.stringify({ cwd: mainCheckout, hook_event_name: "PreToolUse" }));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("gate lets a read-only Bash command through a closed gate", async () => {
  const { lane } = await checkouts();
  const payload = (command: string) =>
    JSON.stringify({ cwd: lane, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

  // Unreachable hub on purpose: a worker inside a stuck lane must still be able
  // to look at its own state.
  for (const command of ["git status --porcelain", "git log -1", "rg TODO src", "ls -la"]) {
    const result = await run(["gate"], payload(command));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  }
});

test("gate denies a mutation hidden behind a read-only prefix", async () => {
  const { lane } = await checkouts();
  const payload = (command: string) =>
    JSON.stringify({ cwd: lane, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

  for (const command of ["git status && rm -rf src", "git log > /tmp/out", "git commit -am wip", "rm -rf src"]) {
    const result = await run(["gate"], payload(command), serve(true, lane));
    expect(result.exitCode).toBe(2);
  }

  // Other tools carry no command to inspect and stay gated as before.
  const edit = await run(["gate"], JSON.stringify({ cwd: lane, hook_event_name: "PreToolUse", tool_name: "Edit" }), serve(true, lane));
  expect(edit.exitCode).toBe(2);
});

test("gate emits the event-specific denial shape", async () => {
  const { lane } = await checkouts();
  const preTool = await run(["gate"], JSON.stringify({ cwd: lane, hook_event_name: "PreToolUse" }), serve(true, lane));
  expect(preTool.exitCode).toBe(2);
  expect(JSON.parse(preTool.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

  // Any other caller — a manual run, a future event — gets the bare exit 2 and
  // no stdout, because a permissionDecision is meaningless outside PreToolUse.
  const other = await run(["gate"], JSON.stringify({ cwd: lane }), serve(true, lane));
  expect(other.exitCode).toBe(2);
  expect(other.stdout).toBe("");
});

test("plan submit sends the given id instead of a generated one", async () => {
  let sent: any;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      sent = await req.json();
      return Response.json({ plan_id: sent.plan_id, revision: 1, revision_id: "rev-1" }, { status: 201 });
    },
  });
  servers.push(server);

  const contentFile = join(tmpdir(), `bridge-plan-${crypto.randomUUID()}.json`);
  await Bun.write(contentFile, JSON.stringify({ goal: "test" }));
  try {
    const result = await run(
      ["plan", "submit", "--title", "A plan", "--content", contentFile, "--id", "phase7-dashboard"],
      "",
      server.url.href,
    );
    expect(result.exitCode).toBe(0);
    expect(sent.plan_id).toBe("phase7-dashboard");
    expect(result.stdout).toContain("phase7-dashboard");
  } finally {
    await rm(contentFile, { force: true });
  }
});

test("state stays non-blocking when the hub is down", async () => {
  const result = await run(["state"]);
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(output.hookSpecificOutput.additionalContext).toContain("unreachable");
});
