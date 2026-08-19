import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildPrompt, buildWorkerEnv, runCodex, type ConductorConfig, type DispatchableLane } from "../src/conductor";

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");

async function tempConfig(): Promise<ConductorConfig> {
  return {
    hubUrl: "http://127.0.0.1:1", // unused in this file
    codexBin: FAKE_CODEX,
    logDir: await mkdtemp(join(tmpdir(), "conductor-logs-")),
    drainIntervalMs: 0,
  };
}

async function tempLane(overrides: Partial<DispatchableLane> = {}): Promise<DispatchableLane> {
  return {
    lane_id: `lane-${crypto.randomUUID()}`,
    owned_paths: ["src/*"],
    lane_type: "write",
    model: "terra",
    depends_on: [],
    worktree_path: await mkdtemp(join(tmpdir(), "conductor-wt-")),
    original_brief: "do the thing",
    resume_decision: null,
    ...overrides,
  };
}

test("buildPrompt passes a fresh lane's brief through unchanged", async () => {
  const lane = await tempLane();
  expect(buildPrompt(lane)).toBe("do the thing");
});

test("buildPrompt appends the approval decision for a resumed lane", async () => {
  const lane = await tempLane({ resume_decision: "use option B" });

  const prompt = buildPrompt(lane);

  expect(prompt).toStartWith("do the thing");
  expect(prompt).toContain("use option B");
});

test("buildWorkerEnv puts the shim first and removes host credentials", () => {
  const shimDir = join(tmpdir(), "laneward-git-shim");
  const env = buildWorkerEnv(
    {
      PATH: ["first", "second"].join(delimiter),
      HOME: "home",
      USERPROFILE: "profile",
      GITHUB_TOKEN: "github",
      GH_TOKEN: "gh",
      GH_ENTERPRISE_TOKEN: "enterprise",
      GITHUB_API_TOKEN: "api",
      GIT_ASKPASS: "askpass",
      SSH_ASKPASS: "ssh-askpass",
      SSH_AUTH_SOCK: "socket",
      ANOTHER_SECRET: "secret",
    },
    {
      shimDir,
      realGit: "real-git",
      guardLogPath: "guard-log",
      ghConfigDir: "empty-gh-config",
    },
  );

  expect(env.PATH.split(delimiter)[0]).toBe(shimDir);
  expect(env).toMatchObject({
    HOME: "home",
    USERPROFILE: "profile",
    LANEWARD_REAL_GIT: "real-git",
    LANEWARD_GIT_GUARD_LOG: "guard-log",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GH_CONFIG_DIR: "empty-gh-config",
  });
  for (const name of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_API_TOKEN",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "ANOTHER_SECRET",
  ]) expect(env[name]).toBeUndefined();
});

// The assertion above mirrors the implementation's own ternary against the host
// platform, so it holds on either platform for the wrong reason and would keep
// holding if the null device were wrong. This is the one that can fail: the
// platform is injected, so both answers are asserted from wherever the suite
// runs, per D-022.
//
// It is also why CP-10 in issue #12 -- "replace the ternary with os.devNull" --
// is not applied. os.devNull reads the real process.platform, which would turn
// this test back into a test of the host.
test("the worker's git config null device follows the injected platform", () => {
  const shimDir = join(tmpdir(), "laneward-git-shim");
  const options = { shimDir, realGit: "g", guardLogPath: "l", ghConfigDir: "c" };

  const windows = buildWorkerEnv({}, { ...options, platform: "win32" });
  expect(windows.GIT_CONFIG_GLOBAL).toBe("NUL");
  expect(windows.GIT_CONFIG_SYSTEM).toBe("NUL");

  const linux = buildWorkerEnv({}, { ...options, platform: "linux" });
  expect(linux.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(linux.GIT_CONFIG_SYSTEM).toBe("/dev/null");
});

test("runCodex returns the child's exit code", async () => {
  const cfg = await tempConfig();
  const lane = await tempLane();
  await writeFile(join(lane.worktree_path, ".exit-code"), "20");

  expect(await runCodex(cfg, lane)).toBe(20);
});

test("runCodex feeds the prompt on stdin, not as an argument", async () => {
  const cfg = await tempConfig();
  const lane = await tempLane({ resume_decision: "use option B" });

  await runCodex(cfg, lane);

  const received = await readFile(join(lane.worktree_path, ".prompt"), "utf8");
  expect(received).toBe(buildPrompt(lane));
});

test("runCodex writes stdout and stderr to a per-lane log file", async () => {
  const cfg = await tempConfig();
  const lane = await tempLane();

  await runCodex(cfg, lane);

  const log = await readFile(join(cfg.logDir, `${lane.lane_id}.log`), "utf8");
  expect(log).toContain("fake codex running in");
  expect(log).toContain("fake codex stderr line");
});

test("runCodex truncates an existing lane log", async () => {
  const cfg = await tempConfig();
  const lane = await tempLane();
  const logPath = join(cfg.logDir, `${lane.lane_id}.log`);
  await writeFile(logPath, `${"old transcript\n".repeat(100)}STALE APPROVAL REQUIRED`);
  await writeFile(join(lane.worktree_path, ".output"), "new transcript only\n");

  await runCodex(cfg, lane);

  const log = await readFile(logPath, "utf8");
  expect(log).toContain("new transcript only");
  expect(log).not.toContain("STALE APPROVAL REQUIRED");
});

test("runCodex writes the log before the child exits", async () => {
  const cfg = await tempConfig();
  const lane = await tempLane();
  const active = new Map<string, Bun.Subprocess>();
  await writeFile(join(lane.worktree_path, ".sleep"), "2");

  const running = runCodex(cfg, lane, active);
  const logPath = join(cfg.logDir, `${lane.lane_id}.log`);
  let log = "";
  for (let i = 0; i < 100 && !log.includes("fake codex running"); i++) {
    await Bun.sleep(10);
    log = await Bun.file(logPath).text();
  }

  expect(log).toContain("fake codex running");
  expect(active.get(lane.lane_id)?.exitCode).toBeNull();
  await running;
});

test("runCodex removes the lane from the active map when it exits", async () => {
  const cfg = await tempConfig();
  const lane = await tempLane();
  const active = new Map<string, Bun.Subprocess>();

  await runCodex(cfg, lane, active);

  expect(active.has(lane.lane_id)).toBe(false);
});
