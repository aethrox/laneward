import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, resolve, win32 } from "node:path";
import { readProjectManifest } from "./lane-checks";

export type DeclaredCleanRunExpectation =
  | { name: string; must_appear: string }
  | { name: string; must_not_appear: string };

interface DeclaredCleanRun {
  shell: string[];
  environment: Record<string, string>;
  seed?: string;
  seed_timeout_ms: number;
  start: string;
  observation_window_ms: number;
  expectations: DeclaredCleanRunExpectation[];
}

export interface CleanRunExpectationResult {
  name: string;
  kind: "must_appear" | "must_not_appear";
  pattern: string;
  seen: boolean;
  met: boolean;
}

export interface CleanRunResult {
  schema_version: 1;
  source: "clean_run";
  manifest_path: string;
  interpreter_path: string | null;
  status: "passed" | "failed" | "unrunnable" | "not_configured";
  expectations: CleanRunExpectationResult[];
  output_path: string | null;
  exit_code: number | null;
  error: string | null;
}

const oneLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
const DEFAULT_SEED_TIMEOUT_MS = 30_000;
type OutputWriter = ReturnType<ReturnType<typeof Bun.file>["writer"]>;

export interface CleanRunInterpreterResolverOptions {
  platform?: string;
  environment?: Record<string, string | undefined>;
  which?: (name: string, options: { PATH: string }) => string | null | undefined;
}

export type CleanRunInterpreterResolution =
  | { interpreter_path: string; error: null }
  | { interpreter_path: string | null; error: string };

export function resolveCleanRunInterpreter(
  declared: string,
  options: CleanRunInterpreterResolverOptions = {},
): CleanRunInterpreterResolution {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const override = environment.LANEWARD_CLEAN_RUN_SHELL;
  const path = platform === "win32" ? win32 : { isAbsolute };
  if (override && !path.isAbsolute(override)) {
    return { interpreter_path: null, error: "LANEWARD_CLEAN_RUN_SHELL must be an absolute path" };
  }

  const interpreter = override ?? (path.isAbsolute(declared)
    ? declared
    : (options.which ?? Bun.which)(declared, { PATH: environment.PATH ?? "" }));
  if (!interpreter) {
    return { interpreter_path: null, error: `could not resolve clean run interpreter ${JSON.stringify(declared)}` };
  }
  if (!override && platform === "win32") {
    const system32 = win32.resolve(environment.SystemRoot ?? "C:\\Windows", "System32");
    const relative = win32.relative(system32, interpreter);
    if (!relative || (!relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative))) {
      return {
        interpreter_path: interpreter,
        error: `refused clean run interpreter ${interpreter}: it starts a Linux environment, so the candidate would be observed on an operating system the host is not`,
      };
    }
  }
  return { interpreter_path: interpreter, error: null };
}

function declaration(value: unknown): DeclaredCleanRun | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("clean_run must be an object");
  }
  const clean = value as Record<string, any>;
  if (!clean.shell || typeof clean.shell !== "object" || Array.isArray(clean.shell)) {
    throw new Error("clean_run.shell must be an object");
  }
  for (const [platform, command] of Object.entries(clean.shell)) {
    if (!platform || !Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string" && part.length > 0)) {
      throw new Error(`clean_run.shell.${platform || "<empty>"} is malformed`);
    }
  }
  const shell = clean.shell[process.platform];
  if (!Array.isArray(shell)) throw new Error(`clean_run.shell.${process.platform} is not configured`);

  if (!clean.environment || typeof clean.environment !== "object" || Array.isArray(clean.environment)) {
    throw new Error("clean_run.environment must be an object");
  }
  const environment: Record<string, string> = {};
  for (const [name, configured] of Object.entries(clean.environment)) {
    if (!name || typeof configured !== "string") throw new Error(`clean_run.environment.${name || "<empty>"} is malformed`);
    if (name.toUpperCase() === "DATABASE_URL") {
      throw new Error("clean_run.environment must not set DATABASE_URL; the candidate must read its own .env");
    }
    environment[name] = configured;
  }

  if (clean.seed !== undefined && (typeof clean.seed !== "string" || clean.seed.length === 0)) {
    throw new Error("clean_run.seed must be a non-empty string");
  }
  if (clean.seed_timeout_ms !== undefined && (!Number.isInteger(clean.seed_timeout_ms) || clean.seed_timeout_ms <= 0)) {
    throw new Error("clean_run.seed_timeout_ms must be a positive integer");
  }
  if (typeof clean.start !== "string" || clean.start.length === 0) {
    throw new Error("clean_run.start must be a non-empty string");
  }
  if (!Number.isInteger(clean.observation_window_ms) || clean.observation_window_ms <= 0) {
    throw new Error("clean_run.observation_window_ms must be a positive integer");
  }
  if (!Array.isArray(clean.expectations) || clean.expectations.length === 0) {
    throw new Error("clean_run.expectations must be a non-empty array");
  }

  const names = new Set<string>();
  const expectations = clean.expectations.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`clean_run.expectations[${index}] is malformed`);
    }
    const item = entry as Record<string, unknown>;
    const hasRequired = typeof item.must_appear === "string";
    const hasForbidden = typeof item.must_not_appear === "string";
    if (typeof item.name !== "string" || item.name.length === 0 || hasRequired === hasForbidden) {
      throw new Error(`clean_run.expectations[${index}] is malformed`);
    }
    if (names.has(item.name)) throw new Error(`duplicate clean run expectation name: ${item.name}`);
    names.add(item.name);
    const pattern = (hasRequired ? item.must_appear : item.must_not_appear) as string;
    try {
      new RegExp(pattern, "m");
    } catch {
      throw new Error(`clean_run.expectations[${index}] has an invalid pattern`);
    }
    // Missing required output fails; missing forbidden output succeeds. Keeping
    // those as distinct keys makes the decision's deliberate asymmetry visible.
    return hasRequired
      ? { name: item.name, must_appear: pattern }
      : { name: item.name, must_not_appear: pattern };
  }) as DeclaredCleanRunExpectation[];

  return {
    shell,
    environment,
    seed: clean.seed,
    seed_timeout_ms: clean.seed_timeout_ms ?? DEFAULT_SEED_TIMEOUT_MS,
    start: clean.start,
    observation_window_ms: clean.observation_window_ms,
    expectations,
  };
}

function childEnv(environment: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...environment };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "DATABASE_URL") delete env[name];
  }
  // Bun does not let the candidate's .env replace an inherited value.
  env.DATABASE_URL = undefined;
  return env;
}

function capture(
  stream: ReadableStream<Uint8Array>,
  output: OutputWriter,
  observe: (text: string) => void = () => {},
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stopping = false;
  let failure: unknown;
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output.write(chunk.value);
        await output.flush();
        observe(decoder.decode(chunk.value, { stream: true }));
      }
      observe(decoder.decode());
    } catch (error) {
      if (!stopping) failure = error;
    }
  })();
  return {
    async stop() {
      stopping = true;
      // The process has already been terminated by the time this runs, so the
      // stream ends on its own and everything still queued gets read. Cancelling
      // first would discard that queue, which is exactly the output written just
      // before the window closed. Cancelling stays as the fallback for a
      // grandchild that survived the kill and still holds the pipe open.
      const drained = await Promise.race([done.then(() => true), Bun.sleep(500).then(() => false)]);
      if (!drained) {
        await reader.cancel().catch(() => {});
        await done;
      }
      if (failure) throw failure;
    },
  };
}

async function terminateProcessTree(proc: Bun.Subprocess, alreadyExited = false): Promise<void> {
  if (alreadyExited) return;
  let failure: unknown;
  try {
    if (process.platform === "win32") {
      const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
      const exitCode = await Bun.spawn([taskkill, "/T", "/F", "/PID", String(proc.pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      // 128 is taskkill's "no such process", the ordinary outcome when the run's
      // own program exited before the window closed. The Linux branch below
      // already tolerates ESRCH for the same reason; treating it as a failure
      // here reported a clean early exit as an unrunnable layer.
      if (exitCode !== 0 && exitCode !== 128) throw new Error(`taskkill exited ${exitCode}`);
    } else if (process.platform === "linux") {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
  }
  if (failure) throw failure;
}

async function runSeed(
  declared: DeclaredCleanRun,
  worktreePath: string,
  output: OutputWriter,
): Promise<number | null> {
  if (!declared.seed) return 0;
  output.write("--- seed ---\n");
  const proc = Bun.spawn([...declared.shell, declared.seed], {
    cwd: worktreePath,
    env: childEnv(declared.environment),
    detached: process.platform === "linux",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const captures = [capture(proc.stdout, output), capture(proc.stderr, output)];
  let timer: ReturnType<typeof setTimeout>;
  const outcome = await Promise.race([
    proc.exited.then((exitCode) => ({ exitCode })),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), declared.seed_timeout_ms);
    }),
  ]);
  clearTimeout(timer!);
  const exited = outcome !== null;
  try {
    await terminateProcessTree(proc, exited);
    await Promise.all(captures.map((stream) => stream.stop()));
  } finally {
    await terminateProcessTree(proc, exited).catch(() => {});
    await Promise.all(captures.map((stream) => stream.stop().catch(() => {})));
  }
  return outcome?.exitCode ?? null;
}

export async function runCleanRun(
  worktreePath: string,
  logDir: string,
): Promise<CleanRunResult> {
  const manifest = await readProjectManifest(worktreePath);
  const finish = (
    status: CleanRunResult["status"],
    options: Partial<Pick<CleanRunResult, "expectations" | "interpreter_path" | "output_path" | "exit_code" | "error">> = {},
  ): CleanRunResult => ({
    schema_version: 1,
    source: "clean_run",
    manifest_path: manifest.manifest_path,
    interpreter_path: options.interpreter_path ?? null,
    status,
    expectations: options.expectations ?? [],
    output_path: options.output_path ?? null,
    exit_code: options.exit_code ?? null,
    error: options.error ?? null,
  });
  if (manifest.status !== "read") {
    return finish(manifest.status, {
      error: manifest.status === "unrunnable" ? "project manifest is malformed" : null,
    });
  }

  let declared: DeclaredCleanRun | undefined;
  try {
    declared = declaration(manifest.value!.clean_run);
  } catch (error) {
    return finish("unrunnable", { error: oneLine(error) });
  }
  if (!declared) return finish("not_configured");

  const interpreter = resolveCleanRunInterpreter(declared.shell[0]);
  if (interpreter.error !== null) return finish("unrunnable", interpreter);
  declared.shell[0] = interpreter.interpreter_path;

  await mkdir(logDir, { recursive: true });
  const safeName = basename(worktreePath).replace(/[^A-Za-z0-9._-]/g, "-") || "candidate";
  const outputPath = resolve(logDir, `${safeName}.clean-run.log`);
  const finishStarted = (
    status: CleanRunResult["status"],
    options: Partial<Pick<CleanRunResult, "expectations" | "exit_code" | "error">> = {},
  ) => finish(status, { ...options, interpreter_path: interpreter.interpreter_path, output_path: outputPath });
  const output = Bun.file(outputPath).writer();
  let proc: Bun.Subprocess | undefined;
  let captures: ReturnType<typeof capture>[] = [];
  let observed = "";
  let exitedEarly = false;
  const details = (): CleanRunExpectationResult[] => declared.expectations.map((expectation) => {
    const required = "must_appear" in expectation;
    const kind = required ? "must_appear" : "must_not_appear";
    const pattern = required ? expectation.must_appear : expectation.must_not_appear;
    const seen = new RegExp(pattern, "m").test(observed);
    return { name: expectation.name, kind, pattern, seen, met: required ? seen : !seen };
  });

  try {
    const seedExitCode = await runSeed(declared, worktreePath, output);
    if (seedExitCode !== 0) {
      return finishStarted("unrunnable", {
        exit_code: seedExitCode,
        error: seedExitCode === null
          ? `seed timed out after ${declared.seed_timeout_ms} ms`
          : `seed exited ${seedExitCode}`,
      });
    }

    output.write("--- start ---\n");
    proc = Bun.spawn([...declared.shell, declared.start], {
      cwd: worktreePath,
      env: childEnv(declared.environment),
      detached: process.platform === "linux",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    captures = [
      capture(proc.stdout as ReadableStream<Uint8Array>, output, (text) => (observed += text)),
      capture(proc.stderr as ReadableStream<Uint8Array>, output, (text) => (observed += text)),
    ];
    let windowClosed = false;
    let exitCode: number | null = null;
    let exitError: unknown;
    void proc.exited.then(
      (code) => {
        if (!windowClosed) {
          exitedEarly = true;
          exitCode = code;
        }
      },
      (error) => (exitError = error),
    );
    await Bun.sleep(declared.observation_window_ms);
    windowClosed = true;
    await terminateProcessTree(proc, exitedEarly);
    await Promise.all(captures.map((stream) => stream.stop()));
    if (exitError) throw exitError;
    const expectations = details();
    if (exitedEarly) {
      return finishStarted("failed", {
        expectations,
        exit_code: exitCode,
        error: `process exited before the ${declared.observation_window_ms} ms observation window ended`,
      });
    }
    return finishStarted(expectations.every((expectation) => expectation.met) ? "passed" : "failed", {
      expectations,
    });
  } catch (error) {
    return finishStarted("unrunnable", {
      expectations: details(),
      error: oneLine(error),
    });
  } finally {
    if (proc) await terminateProcessTree(proc, exitedEarly).catch(() => {});
    await Promise.all(captures.map((stream) => stream.stop().catch(() => {})));
    await output.end();
  }
}
