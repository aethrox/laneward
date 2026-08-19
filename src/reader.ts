import { mkdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { AGENT_ENV_VAR, agentCommand } from "./agent";
import { readProjectManifest } from "./lane-checks";
import { modelForTier } from "./models";

export interface ReaderFinding {
  finding: string;
  subject: "test_diff" | "source_context";
  out_of_change: boolean;
  locations: { path: string; side: "base" | "head"; start_line: number; end_line: number }[];
}

export interface ReaderResult {
  schema_version: 1;
  source: "reader";
  status: "succeeded" | "no_findings" | "failed" | "skipped";
  findings: ReaderFinding[];
  output_path: string | null;
  exit_code: number | null;
  error: string | null;
}

const oneLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();

function testPaths(value: Record<string, unknown>): string[] {
  const reader = value.reader;
  if (!reader || typeof reader !== "object" || Array.isArray(reader)) {
    throw new Error("reader.test_paths is missing");
  }
  const paths = (reader as Record<string, unknown>).test_paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string" && path.length > 0)) {
    throw new Error("reader.test_paths is missing or malformed");
  }
  return paths;
}

function gitDiff(worktreePath: string, baseCommit: string, paths: string[]): string {
  const result = Bun.spawnSync(["git", "-C", worktreePath, "diff", `${baseCommit}..HEAD`, "--", ...paths]);
  if (result.exitCode !== 0) throw new Error(`git diff exited ${result.exitCode}`);
  return new TextDecoder().decode(result.stdout);
}

function prompt(testDiff: string, sourceDiff: string, rejectedFindings: ReaderFinding[]): string {
  const rejected = rejectedFindings.map((item) => JSON.stringify({ finding: item.finding, locations: item.locations })).join("\n");
  return [
    "Review the candidate changes for advisory verification findings. Return findings only; do not make a verdict.",
    "--- TEST DIFF (SUBJECT) ---",
    testDiff,
    "--- SOURCE DIFF (CONTEXT, NOT SUBJECT) ---",
    sourceDiff,
    "--- PREVIOUSLY REJECTED FINDINGS ---",
    rejected || "None.",
    "These findings were adjudicated false. Do not raise them again, but do not treat them as a mechanical filter.",
    "--- OUTPUT CONTRACT ---",
    "End with a fenced ```json block containing {\"findings\":[...]}. Each finding has finding, subject (test_diff or source_context), out_of_change, and locations ({path, side (base or head), start_line, end_line}).",
  ].join("\n");
}

function parseFindings(output: string): ReaderFinding[] {
  const blocks = [...output.matchAll(/```json\s*\r?\n([\s\S]*?)```/gi)];
  if (blocks.length === 0) throw new Error("reader output has no JSON block");
  let report: unknown;
  try {
    report = JSON.parse(blocks.at(-1)![1]);
  } catch {
    throw new Error("reader output has invalid JSON");
  }
  if (!report || typeof report !== "object" || Array.isArray(report) || !Array.isArray((report as Record<string, unknown>).findings)) {
    throw new Error("reader JSON report is malformed");
  }
  const findings = (report as { findings: unknown[] }).findings;
  findings.forEach(validateFinding);
  return findings as ReaderFinding[];
}

function validateFinding(value: unknown): asserts value is ReaderFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reader JSON finding is malformed");
  const finding = value as Record<string, unknown>;
  if (typeof finding.finding !== "string" || finding.finding.length === 0) throw new Error("reader JSON finding is missing finding");
  if (finding.subject !== "test_diff" && finding.subject !== "source_context") throw new Error("reader JSON finding has unknown subject");
  if (typeof finding.out_of_change !== "boolean" || !Array.isArray(finding.locations)) throw new Error("reader JSON finding is malformed");
  for (const location of finding.locations) {
      if (!location || typeof location !== "object" || Array.isArray(location)) throw new Error("reader JSON finding has malformed location");
      const item = location as Record<string, unknown>;
      if (!(typeof item.path === "string" && item.path.length > 0 &&
        (item.side === "base" || item.side === "head") &&
        Number.isInteger(item.start_line) && (item.start_line as number) > 0 &&
        Number.isInteger(item.end_line) && (item.end_line as number) >= (item.start_line as number))) {
        throw new Error("reader JSON finding has malformed location");
      }
  }
}

async function terminateProcessTree(proc: Bun.Subprocess, alreadyExited = false): Promise<void> {
  if (alreadyExited) return;
  try {
    if (process.platform === "win32") {
      const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
      const code = await Bun.spawn([taskkill, "/T", "/F", "/PID", String(proc.pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
      if (code !== 0 && code !== 128) throw new Error(`taskkill exited ${code}`);
    } else if (process.platform === "linux") {
      try { process.kill(-proc.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } finally {
    proc.kill();
    await Promise.resolve(proc.exited).catch(() => {});
  }
}

export async function runReader(
  worktreePath: string,
  baseCommit: string,
  rejectedFindings: ReaderFinding[],
  logDir: string,
  codexBin?: string,
): Promise<ReaderResult> {
  const finish = (status: ReaderResult["status"], options: Partial<Omit<ReaderResult, "schema_version" | "source" | "status">> = {}): ReaderResult => ({
    schema_version: 1, source: "reader", status, findings: options.findings ?? [], output_path: options.output_path ?? null,
    exit_code: options.exit_code ?? null, error: options.error ?? null,
  });
  const manifest = await readProjectManifest(worktreePath);
  if (manifest.status !== "read") {
    return finish("skipped", { error: manifest.status === "not_configured" ? "project manifest is missing" : "project manifest is malformed" });
  }

  let paths: string[];
  try { paths = testPaths(manifest.value!); } catch (error) { return finish("skipped", { error: oneLine(error) }); }

  let testDiff: string;
  let sourceDiff: string;
  try {
    testDiff = gitDiff(worktreePath, baseCommit, paths);
    sourceDiff = gitDiff(worktreePath, baseCommit, [".", ...paths.map((path) => `:(exclude)${path}`)]);
  } catch (error) {
    return finish("failed", { error: oneLine(error) });
  }

  await mkdir(logDir, { recursive: true });
  const safeName = basename(worktreePath).replace(/[^A-Za-z0-9._-]/g, "-") || "candidate";
  const outputPath = resolve(logDir, `${safeName}.reader.log`);
  const output = Bun.file(outputPath).writer();
  let proc: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outputEnded = false;
  let childExited = false;
  try {
    const tier = process.env.LANEWARD_READER_MODEL ?? "terra";
    const model = modelForTier(tier);
    const command = agentCommand("read_only", { worktree: worktreePath, model }, process.env, codexBin);
    // A declared agent with no read-only command cannot be stopped from editing
    // the candidate it is reviewing. The layer is advisory by D-027, so losing
    // it costs findings rather than correctness -- and running it unconfined
    // would cost correctness, which is the trade this refuses to make.
    if (!command) {
      return {
        schema_version: 1,
        source: "reader",
        status: "skipped",
        findings: [],
        output_path: null,
        exit_code: null,
        error: `${AGENT_ENV_VAR.write} is set without ${AGENT_ENV_VAR.read_only}, so the reader has no read-only command and will not run unconfined`,
      };
    }
    proc = Bun.spawn(command, {
      stdin: new TextEncoder().encode(prompt(testDiff, sourceDiff, rejectedFindings)), stdout: "pipe", stderr: "pipe",
    });
    const copy = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) { output.write(chunk); await output.flush(); }
    };
    const timeout = Number(process.env.LANEWARD_READER_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 600_000;
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; void terminateProcessTree(proc!); }, timeoutMs);
    const [exitCode] = await Promise.all([
      Promise.resolve(proc.exited),
      copy(proc.stdout as ReadableStream<Uint8Array>),
      copy(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    childExited = true;
    clearTimeout(timer);
    timer = undefined;
    if (timedOut) return finish("failed", { output_path: outputPath, error: `reader timed out after ${timeoutMs} ms` });
    if (exitCode !== 0) return finish("failed", { output_path: outputPath, exit_code: exitCode, error: `reader exited ${exitCode}` });
    await output.end();
    outputEnded = true;
    const findings = parseFindings(await Bun.file(outputPath).text());
    return finish(findings.length ? "succeeded" : "no_findings", { findings, output_path: outputPath, exit_code: exitCode });
  } catch (error) {
    return finish("failed", { output_path: outputPath, error: oneLine(error) });
  } finally {
    if (timer) clearTimeout(timer);
    if (!outputEnded) await Promise.resolve(output.end()).catch(() => {});
    if (proc) await terminateProcessTree(proc, childExited).catch(() => {});
  }
}
