import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../src/app";
import { sql } from "../src/db";

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");
const ENTRYPOINT = join(import.meta.dir, "..", "conductor.ts");
const server = Bun.serve({ port: 0, fetch: app.fetch });

afterAll(() => server.stop(true));

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals RESTART IDENTITY CASCADE`;
});

// The loop is driven through the real entry point rather than by calling
// runLoop with a stop condition. runLoop returns never on purpose, a seam that
// let a test end it would be a seam the service could end on too, and the whole
// point of D-014 is that nothing ends it but a signal.
function spawnLoop(env: Record<string, string>) {
  return Bun.spawn(["bun", "run", ENTRYPOINT, "--loop"], {
    env: { ...process.env, CODEX_BIN: FAKE_CODEX, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForOutput(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  matches: (seen: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  let seen = "";
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
      if (matches(seen)) return seen;
    }
  } finally {
    reader.releaseLock();
  }
  return seen;
}

test("a failing pass is logged and the loop keeps going", async () => {
  // Port 1 refuses instantly, so every pass throws on its first hub call. If
  // the loop exited on error this would produce one message and a dead process
  // rather than a second message.
  const proc = spawnLoop({
    HUB_URL: "http://127.0.0.1:1",
    LANEWARD_DRAIN_INTERVAL_MS: "50",
    LANEWARD_LOG_DIR: await mkdtemp(join(tmpdir(), "conductor-loop-logs-")),
  });

  try {
    const seen = await waitForOutput(
      proc,
      (text) => text.split("drain pass failed").length > 2,
      15_000,
    );
    expect(seen.split("drain pass failed").length - 1).toBeGreaterThanOrEqual(2);
    expect(proc.killed).toBe(false);
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30_000);

test("the loop announces its interval", async () => {
  const proc = spawnLoop({
    HUB_URL: "http://127.0.0.1:1",
    LANEWARD_DRAIN_INTERVAL_MS: "1234",
    LANEWARD_LOG_DIR: await mkdtemp(join(tmpdir(), "conductor-loop-logs-")),
  });

  try {
    const seen = await waitForOutput(proc, (text) => text.includes("conductor loop started"), 15_000);
    expect(seen).toContain("draining every 1234 ms");
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30_000);

// Same reason as tests/conductor.signals.test.ts: Windows has no POSIX signal
// delivery, so Bun.Subprocess.kill("SIGTERM") terminates the child rather than
// raising a catchable event and the handler never runs. CP-3.
test.skipIf(process.platform === "win32")(
  "SIGTERM stops the loop cleanly and hands a running lane back",
  async () => {
    const worktree = await mkdtemp(join(tmpdir(), "conductor-loop-wt-"));
    Bun.spawnSync(["git", "init", "-q", worktree]);
    await writeFile(join(worktree, "slow.txt"), "change");
    await writeFile(join(worktree, ".sleep"), "30");

    await fetch(new URL("/lanes", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lane_id: "loop-slow",
        owned_paths: ["slow.txt"],
        lane_type: "write",
        model: "terra",
        depends_on: [],
        worktree_path: worktree,
        original_brief: "take your time",
      }),
    });

    const proc = spawnLoop({
      HUB_URL: server.url.href,
      LANEWARD_DRAIN_INTERVAL_MS: "50",
      LANEWARD_LOG_DIR: await mkdtemp(join(tmpdir(), "conductor-loop-logs-")),
    });

    for (let i = 0; i < 100; i++) {
      const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = 'loop-slow'`;
      if (lane?.status === "running") break;
      await Bun.sleep(100);
    }
    const [beforeSignal] = await sql`SELECT status FROM lanes WHERE lane_id = 'loop-slow'`;
    expect(beforeSignal.status).toBe("running");

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;

    // A requested stop that handed its lanes back is a success, so the unit
    // reports inactive rather than failed.
    expect(exitCode).toBe(0);
    const [after] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = 'loop-slow'`;
    expect(after.status).toBe("pending");
    expect(after.attempt_count).toBe(1);
  },
  40_000,
);
