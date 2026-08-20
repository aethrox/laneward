import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLane, type ConductorConfig, type DispatchableLane } from "../src/conductor";

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");
const roots: string[] = [];

// runLane spawns an agent through the generic path, which needs an active
// preset to resolve anything at all -- there is no default.
const previousAgent = process.env.LANEWARD_AGENT;
process.env.LANEWARD_AGENT = "codex";
const requests: Array<{ path: string; body: any }> = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : null;
    requests.push({ path, body });
    if (path.endsWith("/result")) {
      return Response.json({ status: body.exit_code === 0 && body.evidence_passed ? "completed" : "failed" });
    }
    return Response.json({ id: requests.length }, { status: 201 });
  },
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  if (previousAgent === undefined) delete process.env.LANEWARD_AGENT;
  else process.env.LANEWARD_AGENT = previousAgent;
});

beforeEach(() => requests.splice(0));

async function fixture(options: {
  check?: string[];
  dirty?: string | null;
  agentBin?: string;
  output?: string;
  laneType?: "write" | "read_review";
  configured?: boolean;
} = {}): Promise<{ cfg: ConductorConfig; lane: DispatchableLane; marker: string }> {
  const root = await mkdtemp(join(tmpdir(), "conductor checks with spaces "));
  roots.push(root);
  const worktree = join(root, "work tree");
  const logs = join(root, "logs");
  const marker = join(root, "check-ran");
  await mkdir(worktree);
  Bun.spawnSync(["git", "init", "-q", worktree]);
  await mkdir(join(worktree, ".laneward"), { recursive: true });
  if (options.configured !== false) {
    await writeFile(join(worktree, ".laneward", "project.json"), JSON.stringify({
      version: 1,
      checks: { lane: [{ name: "unit", command: options.check ?? markerCheck(marker) }] },
    }));
  }
  await mkdir(join(worktree, ".git", "info"), { recursive: true });
  await writeFile(join(worktree, ".git", "info", "exclude"), ".prompt\n.output\n.exit-code\n");
  Bun.spawnSync(["git", "-C", worktree, "add", "."]);
  Bun.spawnSync(["git", "-C", worktree, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
  if (options.dirty !== null) await writeFile(join(worktree, options.dirty ?? "owned.txt"), "change");
  if (options.output) await writeFile(join(worktree, ".output"), options.output);

  return {
    marker,
    cfg: { hubUrl: server.url.href, agentBin: options.agentBin ?? FAKE_CODEX, logDir: logs, drainIntervalMs: 0 },
    lane: {
      lane_id: `lane-${crypto.randomUUID()}`,
      owned_paths: ["owned.txt"],
      lane_type: options.laneType ?? "write",
      model: "balanced",
      depends_on: [],
      worktree_path: worktree,
      original_brief: "brief",
      resume_decision: null,
    },
  };
}

const markerCheck = (path: string) => [
  process.execPath,
  "-e",
  `await Bun.write(${JSON.stringify(path)}, "ran")`,
];

test("Git boundary failure posts exit 30 before any lane check", async () => {
  const root = await mkdtemp(join(tmpdir(), "boundary codex "));
  roots.push(root);
  const codex = join(root, "boundary-codex.ts");
  await writeFile(codex, `
    const args = Bun.argv.slice(2);
    const worktree = args[args.indexOf("-C") + 1];
    await Bun.stdin.text();
    Bun.spawnSync(["git", "add", "owned.txt"], { cwd: worktree });
  `);
  const seeded = await fixture({ dirty: "owned.txt", agentBin: codex });

  expect(await runLane(seeded.cfg, seeded.lane)).toBe("failed");
  expect(existsSync(seeded.marker)).toBe(false);
  expect(requests.map((request) => request.body.message_type ?? request.body.exit_code)).toEqual(["FAILURE", 30]);
  expect(requests.some((request) => request.body.message_type === "EVIDENCE")).toBe(false);
});

test("no changes and scope failure each skip lane checks", async () => {
  for (const kind of ["no-changes", "scope"] as const) {
    requests.splice(0);
    const seeded = await fixture({
      dirty: kind === "no-changes" ? null : "outside.txt",
      laneType: kind === "no-changes" ? "write" : undefined,
    });
    await runLane(seeded.cfg, seeded.lane);
    expect(existsSync(seeded.marker), kind).toBe(false);
    expect(requests.some((request) => request.body.message_type === "EVIDENCE"), kind).toBe(false);
  }
});

// A sandboxed worker cannot run the checks itself, so an escalation that skipped
// them left every real Codex lane with no evidence at all. The conductor runs
// them on the host; the worker's question still wins the approval request.
test("an escalating worker's owned changes are still checked", async () => {
  const seeded = await fixture({ output: "HOST VERIFICATION REQUIRED: inspect host\n" });

  expect(await runLane(seeded.cfg, seeded.lane)).toBe("waiting_approval");
  expect(existsSync(seeded.marker)).toBe(true);
  expect(requests.map((request) => request.body.message_type)).toEqual(["EVIDENCE", "APPROVAL_REQUEST"]);
  expect(requests[0].body.evidence_refs.overall).toBe("passed");
  expect(requests[1].body.question).toContain("HOST VERIFICATION REQUIRED: inspect host");
  expect(requests.some((request) => request.path.endsWith("/result"))).toBe(false);
});

test("passed evidence is durable before the completed result", async () => {
  const seeded = await fixture();

  expect(await runLane(seeded.cfg, seeded.lane)).toBe("completed");
  expect(requests.map((request) => request.body.message_type ?? request.body.exit_code)).toEqual(["EVIDENCE", 0]);
  expect(requests[0].body.evidence_refs.overall).toBe("passed");
  expect(requests[1].body).toEqual({ exit_code: 0, evidence_passed: true });
});

test("failed checks park for approval and post no result", async () => {
  const seeded = await fixture({ check: [process.execPath, "-e", "process.exit(9)"] });
  expect(await runLane(seeded.cfg, seeded.lane)).toBe("waiting_approval");
  expect(requests.map((request) => request.body.message_type)).toEqual(["EVIDENCE", "APPROVAL_REQUEST"]);
  expect(requests[1].body.question).toContain("failed its lane checks: unit");
  expect(requests.some((request) => request.path.endsWith("/result"))).toBe(false);
});

test("unrunnable checks use a distinct approval question", async () => {
  const seeded = await fixture({ check: [`missing-command-${crypto.randomUUID()}`] });
  expect(await runLane(seeded.cfg, seeded.lane)).toBe("waiting_approval");
  expect(requests[0].body.evidence_refs.overall).toBe("unrunnable");
  expect(requests[1].body.question).toContain("could not run its lane checks:");
  expect(requests[1].body.question).not.toContain("failed its lane checks:");
});

test("a repository without lane checks keeps the completed path", async () => {
  const seeded = await fixture({ configured: false });
  expect(await runLane(seeded.cfg, seeded.lane)).toBe("completed");
  expect(requests[0].body.evidence_refs).toMatchObject({ overall: "not_configured", checks: [] });
  expect(requests[1].body).toEqual({ exit_code: 0, evidence_passed: true });
});
