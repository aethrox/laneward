import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../src/app";
import { sql } from "../src/db";
import { runLane, type ConductorConfig, type DispatchableLane } from "../src/conductor";

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");
const requests: Array<{ method: string; path: string }> = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    requests.push({ method: request.method, path: new URL(request.url).pathname });
    return app.fetch(request);
  },
});

afterAll(() => server.stop(true));

beforeEach(async () => {
  requests.length = 0;
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

async function config(): Promise<ConductorConfig> {
  return {
    hubUrl: server.url.href,
    codexBin: FAKE_CODEX,
    logDir: await mkdtemp(join(tmpdir(), "conductor-logs-")),
    drainIntervalMs: 0,
  };
}

// A worktree that is a real git repo, so evidence checking can run against it.
async function gitWorktree(dirty: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-wt-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  await writeFile(join(dir, ".git", "info", "exclude"), ".prompt\n.exit-code\n.output\n.sleep\n");
  if (dirty) {
    await writeFile(join(dir, dirty), "change");
  }
  return dir;
}

// Registers the lane in HUB and returns the shape the conductor works with.
async function seedLane(
  worktreePath: string,
  overrides: Partial<DispatchableLane> = {},
): Promise<DispatchableLane> {
  const lane: DispatchableLane = {
    lane_id: `lane-${crypto.randomUUID()}`,
    owned_paths: ["owned.txt"],
    lane_type: "write",
    model: "terra",
    depends_on: [],
    worktree_path: worktreePath,
    original_brief: "do the thing",
    resume_decision: null,
    ...overrides,
  };
  const res = await fetch(new URL("/lanes", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(lane),
  });
  expect(res.status).toBe(201);
  await sql`UPDATE lanes SET status = 'running' WHERE lane_id = ${lane.lane_id}`;
  return lane;
}

async function statusOf(laneId: string): Promise<string> {
  const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`;
  return lane.status;
}

// A lane that does not escalate still posts one EVIDENCE message, because a
// worktree with no `.laneward/project.json` records `not_configured`. "Did not
// escalate" is therefore the absence of an APPROVAL_REQUEST, not the absence of
// any message at all.
async function escalationsOf(laneId: string): Promise<unknown[]> {
  return sql`
    SELECT question FROM messages
    WHERE lane_id = ${laneId} AND message_type = 'APPROVAL_REQUEST'
  `;
}

test("runLane completes a clean exit 0 whose changes are all owned", async () => {
  const cfg = await config();
  const lane = await seedLane(await gitWorktree("owned.txt"));

  expect(await runLane(cfg, lane)).toBe("completed");
  expect(await statusOf(lane.lane_id)).toBe("completed");
  expect(requests).toContainEqual({ method: "POST", path: `/lanes/${lane.lane_id}/result` });
});

test("runLane fails an exit 0 that touched an unowned path", async () => {
  const cfg = await config();
  const lane = await seedLane(await gitWorktree("not-owned.txt"));

  expect(await runLane(cfg, lane)).toBe("failed");
  expect(await statusOf(lane.lane_id)).toBe("failed");
  expect(requests).toContainEqual({ method: "POST", path: `/lanes/${lane.lane_id}/result` });
});

test("runLane requests approval when an exit 0 write lane produced no changes", async () => {
  const cfg = await config();
  const lane = await seedLane(await gitWorktree(null));

  expect(await runLane(cfg, lane)).toBe("waiting_approval");
  expect(await statusOf(lane.lane_id)).toBe("waiting_approval");
  expect(requests).toContainEqual({ method: "POST", path: `/lanes/${lane.lane_id}/messages` });
  expect(requests).not.toContainEqual({ method: "POST", path: `/lanes/${lane.lane_id}/result` });

  const [message] = await sql`
    SELECT message_type, question FROM messages WHERE lane_id = ${lane.lane_id}
  `;
  expect(message).toMatchObject({
    message_type: "APPROVAL_REQUEST",
    question: expect.stringContaining("exited 0 without producing changes and needs a decision"),
  });
});

test("runLane requests approval for a host-verification marker", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".output"), "  HOST VERIFICATION REQUIRED: run podman on the host\n");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("waiting_approval");
  expect(await statusOf(lane.lane_id)).toBe("waiting_approval");
  expect(requests).toContainEqual({ method: "POST", path: `/lanes/${lane.lane_id}/messages` });
  expect(requests).not.toContainEqual({ method: "POST", path: `/lanes/${lane.lane_id}/result` });

  const [message] = await escalationsOf(lane.lane_id) as { question: string }[];
  expect(message.question).toContain('"HOST VERIFICATION REQUIRED: run podman on the host"');
});

test("runLane recognizes an approval-required marker case-insensitively", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".output"), "approval required: confirm the revised brief\n");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("waiting_approval");
  const [message] = await escalationsOf(lane.lane_id) as { question: string }[];
  expect(message.question).toContain('"approval required: confirm the revised brief"');
});

test("runLane ignores an escalation phrase mentioned mid-sentence", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".output"), "The brief mentions HOST VERIFICATION REQUIRED as an example.\n");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("completed");
  expect(requests).toContainEqual({ method: "POST", path: `/lanes/${lane.lane_id}/result` });
  expect(await escalationsOf(lane.lane_id)).toEqual([]);
});

// Codex echoes the brief into the transcript, so the escalation block in
// docs/brief-template.md arrives as real lines. A first real run escalated both
// lanes on the template's placeholder instead of what the agent said.
const TEMPLATE_MARKER = "APPROVAL REQUIRED: [your question]";

test("runLane ignores an escalation marker echoed verbatim from the brief", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".output"), `${TEMPLATE_MARKER}\n`);
  const lane = await seedLane(worktree, { original_brief: `do the thing\n${TEMPLATE_MARKER}\n` });

  expect(await runLane(cfg, lane)).toBe("completed");
  expect(await escalationsOf(lane.lane_id)).toEqual([]);
});

test("runLane escalates on the agent's own marker, not the echoed template", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(
    join(worktree, ".output"),
    `${TEMPLATE_MARKER}\nAPPROVAL REQUIRED: src/stranded.ts does not exist\n`,
  );
  const lane = await seedLane(worktree, { original_brief: `do the thing\n${TEMPLATE_MARKER}\n` });

  expect(await runLane(cfg, lane)).toBe("waiting_approval");
  const [message] = await escalationsOf(lane.lane_id) as { question: string }[];
  expect(message.question).toContain('"APPROVAL REQUIRED: src/stranded.ts does not exist"');
  expect(message.question).not.toContain("[your question]");
});

test("runLane returns an exit 20 lane to pending and counts the attempt", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".exit-code"), "20");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("pending");

  const [row] = await sql`SELECT attempt_count FROM lanes WHERE lane_id = ${lane.lane_id}`;
  expect(row.attempt_count).toBe(1);
});

test("runLane fails an exit 20 lane on its third attempt", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".exit-code"), "20");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("pending");
  expect(await runLane(cfg, lane)).toBe("pending");
  expect(await runLane(cfg, lane)).toBe("failed");
});

test("runLane fails an exit 30 lane immediately without counting an attempt", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".exit-code"), "30");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("failed");

  const [row] = await sql`SELECT attempt_count FROM lanes WHERE lane_id = ${lane.lane_id}`;
  expect(row.attempt_count).toBe(0);
});

test("runLane parks an exit 10 lane on an approval request", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".exit-code"), "10");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("waiting_approval");
  expect(await statusOf(lane.lane_id)).toBe("waiting_approval");

  const [approval] = await sql`
    SELECT id FROM approvals WHERE lane_id = ${lane.lane_id} AND resolved_at IS NULL
  `;
  expect(approval).toBeDefined();
});

test("runLane treats an unrecognized exit code as an ordinary failure", async () => {
  const cfg = await config();
  const worktree = await gitWorktree("owned.txt");
  await writeFile(join(worktree, ".exit-code"), "7");
  const lane = await seedLane(worktree);

  expect(await runLane(cfg, lane)).toBe("pending");

  const [row] = await sql`SELECT attempt_count FROM lanes WHERE lane_id = ${lane.lane_id}`;
  expect(row.attempt_count).toBe(1);
});

test("runLane accepts a read_review lane that changed nothing", async () => {
  const cfg = await config();
  const lane = await seedLane(await gitWorktree(null), { lane_type: "read_review" });

  expect(await runLane(cfg, lane)).toBe("completed");
});

// S2b's acceptance criterion: an agent that is not Codex drives a lane to
// completion through configuration alone, with no source change. The fixture
// takes a `run` verb and --workdir/--model, so nothing about the Codex flag
// shape survives if this passes.
test("a non-Codex agent completes a lane through configuration alone", async () => {
  const previous = process.env.LANEWARD_AGENT_WRITE;
  process.env.LANEWARD_AGENT_WRITE = JSON.stringify([
    join(import.meta.dir, "fixtures", "fake-agent.ts"),
    "run",
    "--workdir",
    "{worktree}",
    "--model",
    "{model}",
  ]);
  try {
    const cfg = await config();
    const lane = await seedLane(await gitWorktree("owned.txt"));

    expect(await runLane(cfg, lane)).toBe("completed");
    expect(await statusOf(lane.lane_id)).toBe("completed");

    // The agent, not Codex, is what actually ran.
    const log = await Bun.file(join(cfg.logDir, `${lane.lane_id}.log`)).text();
    expect(log).toContain("fake agent running in");
  } finally {
    if (previous === undefined) delete process.env.LANEWARD_AGENT_WRITE;
    else process.env.LANEWARD_AGENT_WRITE = previous;
  }
});
