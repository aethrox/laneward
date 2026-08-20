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

// Windows has no POSIX signal delivery: Bun.Subprocess.kill("SIGINT") there
// terminates the child unconditionally (confirmed by probing a bare
// process.on("SIGINT") handler, which never ran and the child exited 130)
// rather than raising a catchable event, so installSignalHandlers's cleanup
// never gets a chance to run before the process dies. This is a real gap
// recorded in docs/architecture/workflow-v1/09-implementation-roadmap.md
// under the Phase 2b status section, not something this test can paper over.
test.skipIf(process.platform === "win32")(
  "SIGINT kills the children and hands the lanes back to HUB",
  async () => {
    const worktree = await mkdtemp(join(tmpdir(), "conductor-wt-"));
    Bun.spawnSync(["git", "init", "-q", worktree]);
    await writeFile(join(worktree, "slow.txt"), "change");
    await writeFile(join(worktree, ".sleep"), "30");

    await fetch(new URL("/lanes", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lane_id: "slow",
        owned_paths: ["slow.txt"],
        lane_type: "write",
        model: "balanced",
        depends_on: [],
        worktree_path: worktree,
        original_brief: "take your time",
      }),
    });

    const proc = Bun.spawn(["bun", "run", ENTRYPOINT], {
      env: {
        ...process.env,
        HUB_URL: server.url.href,
        LANEWARD_AGENT: "codex",
        LANEWARD_AGENT_BIN: FAKE_CODEX,
        LANEWARD_LOG_DIR: await mkdtemp(join(tmpdir(), "conductor-logs-")),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait until the lane is actually running before interrupting.
    for (let i = 0; i < 100; i++) {
      const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = 'slow'`;
      if (lane?.status === "running") break;
      await Bun.sleep(100);
    }
    const [beforeSignal] = await sql`SELECT status FROM lanes WHERE lane_id = 'slow'`;
    expect(beforeSignal.status).toBe("running");

    proc.kill("SIGINT");
    await proc.exited;

    const [after] = await sql`SELECT status, attempt_count FROM lanes WHERE lane_id = 'slow'`;
    expect(after.status).toBe("pending");
    expect(after.attempt_count).toBe(1);
  },
  30_000,
);
