import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface LaneCheckResult {
  name: string;
  command: string[];
  status: "passed" | "failed" | "unrunnable";
  exit_code: number | null;
  duration_ms: number;
  output_path: string;
  error: string | null;
}

export interface LaneCheckEvidence {
  schema_version: 1;
  source: "lane_checks";
  manifest_path: string;
  overall: "passed" | "failed" | "unrunnable" | "not_configured";
  started_at: string;
  finished_at: string;
  checks: LaneCheckResult[];
}

interface DeclaredCheck {
  name: string;
  command: string[];
}

export interface ProjectManifestRead {
  manifest_path: string;
  status: "read" | "not_configured" | "unrunnable";
  value?: Record<string, unknown>;
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

function readChecks(value: Record<string, unknown>): DeclaredCheck[] {
  const checks = (value as any).checks;
  if (checks === undefined) return [];
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
    throw new Error("checks must be an object");
  }
  const lane = checks.lane;
  if (lane === undefined) return [];
  if (!Array.isArray(lane)) throw new Error("checks.lane must be an array");

  const names = new Set<string>();
  return lane.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !Array.isArray(entry.command) ||
      entry.command.length === 0 ||
      !entry.command.every((part: unknown) => typeof part === "string")
    ) {
      throw new Error(`checks.lane[${index}] is malformed`);
    }
    if (names.has(entry.name)) throw new Error(`duplicate check name: ${entry.name}`);
    names.add(entry.name);
    return { name: entry.name, command: entry.command };
  });
}

export async function readProjectManifest(worktreePath: string): Promise<ProjectManifestRead> {
  const manifestPath = resolve(worktreePath, ".laneward", "project.json");
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) return { manifest_path: manifestPath, status: "not_configured" };

  try {
    const value: unknown = JSON.parse(await file.text());
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as any).version !== 1) {
      throw new Error("manifest version must be 1");
    }
    return { manifest_path: manifestPath, status: "read", value: value as Record<string, unknown> };
  } catch {
    return { manifest_path: manifestPath, status: "unrunnable" };
  }
}

async function runCheck(
  check: DeclaredCheck,
  index: number,
  laneId: string,
  worktreePath: string,
  logDir: string,
  timeoutMs: number,
): Promise<LaneCheckResult> {
  const started = performance.now();
  const safeName = check.name.replace(/[^A-Za-z0-9._-]/g, "-");
  const outputPath = resolve(logDir, `${laneId}.check-${index}-${safeName}.log`);
  const output = Bun.file(outputPath).writer();

  try {
    const proc = Bun.spawn(check.command, {
      cwd: worktreePath,
      // The child must read the lane worktree's own .env. Bun will not let a
      // .env file override a variable already in the environment, so an
      // inherited DATABASE_URL would point the lane's suite at the hub's
      // database and truncate it.
      env: { ...process.env, DATABASE_URL: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const copy = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        output.write(chunk);
        await output.flush();
      }
    };

    try {
      const [exitCode] = await Promise.all([proc.exited, copy(proc.stdout), copy(proc.stderr)]);
      if (timedOut) {
        return {
          name: check.name,
          command: check.command,
          status: "unrunnable",
          exit_code: null,
          duration_ms: Math.round(performance.now() - started),
          output_path: outputPath,
          error: `timed out after ${timeoutMs} ms`,
        };
      }
      return {
        name: check.name,
        command: check.command,
        status: exitCode === 0 ? "passed" : "failed",
        exit_code: exitCode,
        duration_ms: Math.round(performance.now() - started),
        output_path: outputPath,
        error: null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      name: check.name,
      command: check.command,
      status: "unrunnable",
      exit_code: null,
      duration_ms: Math.round(performance.now() - started),
      output_path: outputPath,
      error: oneLine(error),
    };
  } finally {
    await output.end();
  }
}

export async function runLaneChecks(
  laneId: string,
  worktreePath: string,
  logDir: string,
): Promise<LaneCheckEvidence> {
  const startedAt = new Date().toISOString();
  const manifest = await readProjectManifest(worktreePath);
  const manifestPath = manifest.manifest_path;
  const finish = (
    overall: LaneCheckEvidence["overall"],
    checks: LaneCheckResult[] = [],
  ): LaneCheckEvidence => ({
    schema_version: 1,
    source: "lane_checks",
    manifest_path: manifestPath,
    overall,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    checks,
  });

  if (manifest.status !== "read") return finish(manifest.status);

  let declared: DeclaredCheck[];
  try {
    declared = readChecks(manifest.value!);
  } catch {
    return finish("unrunnable");
  }
  if (declared.length === 0) return finish("not_configured");

  await mkdir(logDir, { recursive: true });
  const configuredTimeout = Number(process.env.LANEWARD_CHECK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 600_000;
  const checks: LaneCheckResult[] = [];
  for (let index = 0; index < declared.length; index++) {
    checks.push(await runCheck(declared[index], index, laneId, worktreePath, logDir, timeoutMs));
  }
  const overall = checks.some((check) => check.status === "unrunnable")
    ? "unrunnable"
    : checks.some((check) => check.status === "failed") ? "failed" : "passed";
  return finish(overall, checks);
}
