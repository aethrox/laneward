import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveCleanRunInterpreter, runCleanRun } from "../src/clean-run";
import { runLaneChecks } from "../src/lane-checks";

const roots: string[] = [];

// LANEWARD_CLEAN_RUN_SHELL is an operator escape hatch that the resolver checks
// before anything else, so a test asserting how an interpreter is *resolved*
// measures nothing if it inherits the variable from whoever ran the suite. On a
// host where bare `bash` is WSL, setting it is the only way to run the drain
// tests at all, and doing so silently rewrote ten expectations here. The tests
// that want it set it themselves.
const inheritedShell = process.env.LANEWARD_CLEAN_RUN_SHELL;

beforeAll(() => {
  delete process.env.LANEWARD_CLEAN_RUN_SHELL;
});

afterAll(async () => {
  if (inheritedShell !== undefined) process.env.LANEWARD_CLEAN_RUN_SHELL = inheritedShell;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(manifest?: unknown, raw = false) {
  const root = await mkdtemp(join(tmpdir(), "lane checks with spaces "));
  roots.push(root);
  const worktree = join(root, "work tree");
  const logs = join(root, "check logs");
  await mkdir(worktree, { recursive: true });
  if (manifest !== undefined) {
    await mkdir(join(worktree, ".laneward"));
    await writeFile(
      join(worktree, ".laneward", "project.json"),
      raw ? String(manifest) : JSON.stringify(manifest),
    );
  }
  return { worktree, logs };
}

const manifest = (lane: unknown[]) => ({ version: 1, checks: { lane } });
const command = (source: string) => [process.execPath, "-e", source];

function cleanDeclaration(expectations: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    shell: { [process.platform]: ["bun", "-e"] },
    environment: {},
    start: "import('./fake-clean-run.ts')",
    // Starting a Bun module was measured at ~1.9 s on this host, so any
    // window near it decides the outcome by machine speed rather than by what
    // the process printed. Every case here waits the full window, which is why
    // each one that starts a process also carries its own 20 s budget: bun's
    // 5 s default would otherwise expire before the window it is waiting on.
    observation_window_ms: 5000,
    expectations,
    ...overrides,
  };
}

async function cleanFixture(cleanRun: unknown, source?: string) {
  const item = await fixture({ version: 1, clean_run: cleanRun });
  if (source !== undefined) await writeFile(join(item.worktree, "fake-clean-run.ts"), source);
  return item;
}

test("missing declaration and an empty checks.lane are not configured", async () => {
  const missing = await fixture();
  expect(await runLaneChecks("missing", missing.worktree, missing.logs)).toMatchObject({
    overall: "not_configured",
    checks: [],
  });

  const empty = await fixture(manifest([]));
  expect(await runLaneChecks("empty", empty.worktree, empty.logs)).toMatchObject({
    overall: "not_configured",
    checks: [],
  });
});

test("malformed JSON and an unsupported version are unrunnable", async () => {
  const malformed = await fixture("{", true);
  expect((await runLaneChecks("bad-json", malformed.worktree, malformed.logs)).overall).toBe("unrunnable");

  const wrongVersion = await fixture({ version: 2, checks: { lane: [] } });
  expect((await runLaneChecks("bad-version", wrongVersion.worktree, wrongVersion.logs)).overall).toBe("unrunnable");

  const duplicate = await fixture(manifest([
    { name: "same", command: ["first"] },
    { name: "same", command: ["second"] },
  ]));
  expect((await runLaneChecks("duplicate", duplicate.worktree, duplicate.logs)).overall).toBe("unrunnable");

  const malformedEntry = await fixture(manifest([{ name: "empty-command", command: [] }]));
  expect((await runLaneChecks("bad-entry", malformedEntry.worktree, malformedEntry.logs)).overall).toBe("unrunnable");
});

test("a zero exit passes and a nonzero exit preserves the project's verdict", async () => {
  const passing = await fixture(manifest([{ name: "unit", command: command("process.exit(0)") }]));
  expect(await runLaneChecks("pass", passing.worktree, passing.logs)).toMatchObject({
    overall: "passed",
    checks: [{ status: "passed", exit_code: 0, error: null }],
  });

  const failing = await fixture(manifest([{ name: "unit", command: command("process.exit(7)") }]));
  expect(await runLaneChecks("fail", failing.worktree, failing.logs)).toMatchObject({
    overall: "failed",
    checks: [{ status: "failed", exit_code: 7, error: null }],
  });
});

test("a missing binary is unrunnable without an exit code", async () => {
  const item = await fixture(manifest([{
    name: "missing",
    command: [`laneward-command-that-does-not-exist-${crypto.randomUUID()}`],
  }]));
  const result = await runLaneChecks("missing-bin", item.worktree, item.logs);
  expect(result).toMatchObject({
    overall: "unrunnable",
    checks: [{ status: "unrunnable", exit_code: null }],
  });
  expect(result.checks[0].error?.length).toBeGreaterThan(0);
});

test("a timed-out check is killed and has no verdict", async () => {
  const pidPath = join(tmpdir(), `laneward-check-${crypto.randomUUID()}.pid`);
  const item = await fixture(manifest([{
    name: "slow",
    command: command(`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`),
  }]));
  const previous = process.env.LANEWARD_CHECK_TIMEOUT_MS;
  // Long enough for the child to boot and record its pid, short enough to keep
  // the test quick. A 30ms budget killed it before it ever wrote the file.
  process.env.LANEWARD_CHECK_TIMEOUT_MS = "2000";
  try {
    const result = await runLaneChecks("timeout", item.worktree, item.logs);
    expect(result).toMatchObject({
      overall: "unrunnable",
      checks: [{ status: "unrunnable", exit_code: null, error: expect.stringContaining("timed out") }],
    });
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await rm(pidPath, { force: true });
  } finally {
    if (previous === undefined) delete process.env.LANEWARD_CHECK_TIMEOUT_MS;
    else process.env.LANEWARD_CHECK_TIMEOUT_MS = previous;
  }
});

test("unrunnable outranks failed", async () => {
  const item = await fixture(manifest([
    { name: "failure", command: command("process.exit(4)") },
    { name: "missing", command: [`laneward-command-that-does-not-exist-${crypto.randomUUID()}`] },
  ]));
  const result = await runLaneChecks("precedence", item.worktree, item.logs);
  expect(result.overall).toBe("unrunnable");
  expect(result.checks.map((check) => check.status)).toEqual(["failed", "unrunnable"]);
});

test("stdout and stderr are stored in the referenced output file", async () => {
  const item = await fixture(manifest([{
    name: "output/name",
    command: command("console.log('stdout-value'); console.error('stderr-value')"),
  }]));
  const result = await runLaneChecks("output", item.worktree, item.logs);
  const output = await readFile(result.checks[0].output_path, "utf8");
  expect(output).toContain("stdout-value");
  expect(output).toContain("stderr-value");
  expect(result.checks[0].output_path).toEndWith("output.check-0-output-name.log");
});

test("the child does not inherit DATABASE_URL", async () => {
  const item = await fixture(manifest([{
    name: "database-url",
    command: command("console.log('DATABASE_URL=' + String(process.env.DATABASE_URL))"),
  }]));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://hub/should-not-reach-the-child";
  try {
    const result = await runLaneChecks("env", item.worktree, item.logs);
    const output = await readFile(result.checks[0].output_path, "utf8");
    expect(output).toContain("DATABASE_URL=undefined");
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("a clean run fails when required output is missing and names the unmet expectation", async () => {
  const item = await cleanFixture(
    cleanDeclaration([{ name: "required-event", must_appear: "required-event" }]),
    "console.log(`PID=${process.pid}`); setInterval(() => {}, 1000);",
  );

  const result = await runCleanRun(item.worktree, item.logs);

  expect(result).toMatchObject({
    status: "failed",
    exit_code: null,
    expectations: [{ name: "required-event", seen: false, met: false }],
  });
  expect(typeof result.output_path).toBe("string");
  if (typeof result.output_path !== "string") throw new Error("clean run did not return its output path");
  const output = await readFile(result.output_path, "utf8");
  const pid = Number(output.match(/PID=(\d+)/)?.[1]);
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);

test("a clean run fails when forbidden output appears", async () => {
  const item = await cleanFixture(
    cleanDeclaration([{ name: "forbidden-event", must_not_appear: "forbidden-event" }]),
    "console.error('forbidden-event'); setInterval(() => {}, 1000);",
  );

  expect(await runCleanRun(item.worktree, item.logs)).toMatchObject({
    status: "failed",
    expectations: [{ name: "forbidden-event", seen: true, met: false }],
  });
}, 20_000);

test("a clean run process that exits before the window fails with its exit code", async () => {
  const item = await cleanFixture(
    cleanDeclaration([{ name: "booted", must_appear: "booted" }]),
    "console.log('booted'); process.exit(7);",
  );

  expect(await runCleanRun(item.worktree, item.logs)).toMatchObject({
    status: "failed",
    exit_code: 7,
    error: expect.stringContaining("observation window"),
  });
}, 20_000);

test("a bare clean run interpreter is resolved and recorded", async () => {
  const item = await cleanFixture(
    cleanDeclaration([{ name: "booted", must_appear: "booted" }]),
    "console.log('booted'); setInterval(() => {}, 1000);",
  );

  const result = await runCleanRun(item.worktree, item.logs);
  expect(result.status).toBe("passed");
  expect(result.interpreter_path).not.toBeNull();
  if (result.interpreter_path === null) throw new Error("clean run did not resolve its interpreter");
  expect(isAbsolute(result.interpreter_path)).toBe(true);
}, 20_000);

test("an absolute clean run interpreter is used unchanged", async () => {
  const item = await cleanFixture(
    cleanDeclaration(
      [{ name: "booted", must_appear: "booted" }],
      { shell: { [process.platform]: [process.execPath, "-e"] } },
    ),
    "console.log('booted'); setInterval(() => {}, 1000);",
  );

  const result = await runCleanRun(item.worktree, item.logs);
  expect(result.status).toBe("passed");
  expect(result.interpreter_path).toBe(process.execPath);
}, 20_000);

test("an unresolved clean run interpreter is unrunnable", async () => {
  const name = `laneward-clean-run-that-does-not-exist-${crypto.randomUUID()}`;
  const item = await cleanFixture(cleanDeclaration([{ name: "never", must_appear: "never" }], {
    shell: { [process.platform]: [name, "-e"] },
  }));

  const result = await runCleanRun(item.worktree, item.logs);
  expect(result.status).toBe("unrunnable");
  expect(result.error).toContain(name);
  expect(result.interpreter_path).toBeNull();
});

test("LANEWARD_CLEAN_RUN_SHELL replaces the declared interpreter", async () => {
  const item = await cleanFixture(
    cleanDeclaration([{ name: "booted", must_appear: "booted" }], {
      shell: { [process.platform]: ["laneward-clean-run-that-does-not-exist", "-e"] },
    }),
    "console.log('booted'); setInterval(() => {}, 1000);",
  );
  const previous = process.env.LANEWARD_CLEAN_RUN_SHELL;
  process.env.LANEWARD_CLEAN_RUN_SHELL = process.execPath;
  try {
    const result = await runCleanRun(item.worktree, item.logs);
    expect(result.status).toBe("passed");
    expect(result.interpreter_path).toBe(process.execPath);
  } finally {
    if (previous === undefined) delete process.env.LANEWARD_CLEAN_RUN_SHELL;
    else process.env.LANEWARD_CLEAN_RUN_SHELL = previous;
  }
}, 20_000);

test("the resolver refuses System32 on Windows but not on Linux, unless explicitly overridden", () => {
  const system32Bash = "C:\\Windows\\System32\\bash.exe";
  const options = {
    environment: { SystemRoot: "C:\\Windows", PATH: "" },
    which: () => system32Bash,
  };
  const refused = resolveCleanRunInterpreter("bash", { ...options, platform: "win32" });
  expect(refused.interpreter_path).toBe(system32Bash);
  expect(refused.error).toContain(system32Bash);
  expect(resolveCleanRunInterpreter("bash", { ...options, platform: "linux" })).toEqual({
    interpreter_path: system32Bash,
    error: null,
  });
  expect(resolveCleanRunInterpreter("bash", {
    ...options,
    platform: "win32",
    environment: { ...options.environment, LANEWARD_CLEAN_RUN_SHELL: system32Bash },
  })).toEqual({ interpreter_path: system32Bash, error: null });
  expect(resolveCleanRunInterpreter("bash", {
    ...options,
    platform: "win32",
    environment: { ...options.environment, LANEWARD_CLEAN_RUN_SHELL: "bash" },
  })).toEqual({ interpreter_path: null, error: "LANEWARD_CLEAN_RUN_SHELL must be an absolute path" });
});

test("a missing or malformed clean run declaration never passes", async () => {
  const missing = await fixture();
  expect((await runCleanRun(missing.worktree, missing.logs)).status).toBe("not_configured");

  const malformed = await cleanFixture(cleanDeclaration([], { expectations: [] }));
  expect((await runCleanRun(malformed.worktree, malformed.logs)).status).toBe("unrunnable");
});

test("a clean run child does not inherit the parent's DATABASE_URL", async () => {
  const item = await cleanFixture(
    cleanDeclaration([{ name: "candidate environment", must_appear: "DATABASE_URL=undefined" }]),
    "console.log('DATABASE_URL=' + String(process.env.DATABASE_URL)); setInterval(() => {}, 1000);",
  );
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://hub/should-not-reach-the-clean-run";
  try {
    expect(await runCleanRun(item.worktree, item.logs)).toMatchObject({
      status: "passed",
      expectations: [{ name: "candidate environment", seen: true, met: true }],
    });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}, 20_000);

test("the optional clean run seed finishes before the observed process starts", async () => {
  const item = await cleanFixture(
    cleanDeclaration(
      [{ name: "seeded state", must_appear: "seeded-state" }],
      { seed: "import('./seed-clean-run.ts')" },
    ),
    "console.log(await Bun.file('seeded.txt').text()); setInterval(() => {}, 1000);",
  );
  await writeFile(join(item.worktree, "seed-clean-run.ts"), "await Bun.write('seeded.txt', 'seeded-state');\n");

  expect(await runCleanRun(item.worktree, item.logs)).toMatchObject({
    status: "passed",
    expectations: [{ name: "seeded state", seen: true, met: true }],
  });
}, 20_000);

test("a failed clean run seed is unrunnable with its exit code and never starts the process", async () => {
  const item = await cleanFixture(
    cleanDeclaration(
      [{ name: "never started", must_appear: "never" }],
      { seed: "import('./seed-clean-run.ts')", seed_timeout_ms: 2000 },
    ),
    "await Bun.write('started.txt', 'started'); setInterval(() => {}, 1000);",
  );
  await writeFile(join(item.worktree, "seed-clean-run.ts"), "process.exit(9);\n");

  expect(await runCleanRun(item.worktree, item.logs)).toMatchObject({
    status: "unrunnable",
    exit_code: 9,
    error: "seed exited 9",
  });
  expect(await Bun.file(join(item.worktree, "started.txt")).exists()).toBe(false);
}, 20_000);

// The assertion the whole layer was missing. Every other test here reads the
// result and stops there, so the suite stayed green while each run left a live
// process behind: git-bash's `bash.exe` starts the program as a separate Windows
// process and exits, so `taskkill /T` walks the tree of a pid that is already
// gone and the real program is orphaned. This layer starts a server on a fixed
// port, so one survivor makes the next run fail for a reason that has nothing to
// do with the candidate.
test("nothing the clean run started is still alive afterwards", async () => {
  const item = await cleanFixture(
    cleanDeclaration([{ name: "booted", must_appear: "booted" }]),
    "await Bun.write('child.pid', String(process.pid)); console.log('booted'); setInterval(() => {}, 1000);",
  );

  const result = await runCleanRun(item.worktree, item.logs);
  expect(result.status).toBe("passed");

  const pid = Number(await readFile(join(item.worktree, "child.pid"), "utf8"));
  expect(Number.isInteger(pid)).toBe(true);
  // Signal 0 tests for existence without delivering anything, on Windows too.
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A killed process can take a moment to leave the table; a second is generous
  // and still fails fast when nothing was killed at all.
  for (let waited = 0; waited < 1000 && alive(); waited += 50) await Bun.sleep(50);
  expect(alive()).toBe(false);
}, 20_000);
