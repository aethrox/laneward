import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import { agentCommand } from "./agent";
import { runCleanRun, type CleanRunResult } from "./clean-run";
import { runLaneChecks } from "./lane-checks";
import { modelForTier } from "./models";
import { defaultLogDir } from "./paths";
import { runReader, type ReaderFinding, type ReaderResult } from "./reader";

export interface ConductorConfig {
  hubUrl: string;
  agentBin?: string;
  logDir: string;
  drainIntervalMs: number;
  candidateScript?: string;
}

export interface DispatchableLane {
  lane_id: string;
  owned_paths: string[];
  lane_type: "write" | "read_review";
  model: string;
  depends_on: string[];
  worktree_path: string;
  original_brief: string;
  resume_decision: string | null;
}

export function buildPrompt(lane: DispatchableLane): string {
  if (!lane.resume_decision) {
    return lane.original_brief;
  }
  return `${lane.original_brief}\n\n--- APPROVAL DECISION ---\n${lane.resume_decision}`;
}

export interface GitState {
  head: string | null;
  ref: string | null;
}

export interface WorkerEnvOptions {
  shimDir: string;
  realGit: string;
  guardLogPath: string;
  ghConfigDir: string;
  platform?: NodeJS.Platform;
}

function valueFor(env: Record<string, string | undefined>, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

function isCredentialVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return new Set([
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_API_TOKEN",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "DATABASE_URL",
  ]).has(upper) || /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|ASKPASS|AUTH_SOCK)$/.test(upper);
}

// A worker needs the agent's own HOME and USERPROFILE, but not the host's Git,
// GitHub, SSH, or database credentials. Local repository config remains
// readable, including its remote URL.
export function buildWorkerEnv(
  baseEnv: Record<string, string | undefined>,
  options: WorkerEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const upper = key.toUpperCase();
    if (
      value === undefined ||
      upper === "PATH" ||
      upper === "GH_CONFIG_DIR" ||
      isCredentialVariable(key) ||
      upper === "GIT_DIR" ||
      upper === "GIT_WORK_TREE" ||
      upper === "GIT_INDEX_FILE" ||
      upper === "GIT_COMMON_DIR" ||
      upper === "GIT_OBJECT_DIRECTORY" ||
      upper === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(upper)
    ) continue;
    env[key] = value;
  }

  const path = valueFor(baseEnv, "PATH");
  const platform = options.platform ?? process.platform;
  env.PATH = path ? `${options.shimDir}${delimiter}${path}` : options.shimDir;
  env.LANEWARD_REAL_GIT = options.realGit;
  env.LANEWARD_GIT_GUARD_LOG = options.guardLogPath;
  // Not os.devNull, deliberately: it reads the real process.platform, and this
  // function takes the platform as a parameter so the Windows worker
  // environment can be asserted from Linux and back, per D-022. Substituting
  // the constant would silently turn that test into a test of the host. This is
  // why CP-10 in issue #12 is closed rather than applied.
  env.GIT_CONFIG_GLOBAL = platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_CONFIG_SYSTEM = platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_CONFIG_DIR = options.ghConfigDir;
  return env;
}

function resolveRealGit(baseEnv: Record<string, string | undefined>): string {
  const git = Bun.which("git", { PATH: valueFor(baseEnv, "PATH") ?? "" });
  if (!git) throw new Error("could not resolve git from the conductor PATH");
  return git;
}

export function snapshotGitState(worktree: string): GitState {
  const inspect = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", worktree, ...args]);
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() || null : null;
  };
  return {
    head: inspect(["rev-parse", "--verify", "HEAD"]),
    ref: inspect(["symbolic-ref", "-q", "HEAD"]),
  };
}

function guardLogPath(cfg: ConductorConfig, lane: DispatchableLane): string {
  return join(cfg.logDir, `${lane.lane_id}.git-guard.jsonl`);
}

// The brief goes in on stdin. A positional prompt makes a backgrounded
// agent wait on stdin anyway, and it hangs forever.
//
// The child inherits this process's environment, and Bun auto-loads `.env` from
// the working directory, so running the conductor from the laneward checkout
// pushed laneward's own `PORT` and `DATABASE_URL` into every lane. A lane then
// served the driven repository on 8787 and collided with HUB. The `conductor`
// script therefore runs with `--no-env-file`; the conductor needs no
// settings from a file. Invoking `bun run conductor.ts` directly bypasses that.
export async function runAgent(
  cfg: ConductorConfig,
  lane: DispatchableLane,
  active?: Map<string, Bun.Subprocess>,
): Promise<number> {
  await mkdir(cfg.logDir, { recursive: true });
  const logPath = join(cfg.logDir, `${lane.lane_id}.log`);
  const gitGuardLog = guardLogPath(cfg, lane);
  const ghConfigDir = await mkdtemp(join(cfg.logDir, `${lane.lane_id}.gh-`));
  await writeFile(logPath, "");
  await writeFile(gitGuardLog, "");

  const model = modelForTier(lane.model);
  // Never null for "write": only the read-only template can be absent.
  const command = agentCommand("write", { worktree: lane.worktree_path, model }, process.env, cfg.agentBin)!;
  const proc = Bun.spawn(
    command,
    {
      cwd: lane.worktree_path,
      stdin: new TextEncoder().encode(buildPrompt(lane)),
      stdout: "pipe",
      stderr: "pipe",
      env: buildWorkerEnv(process.env, {
        shimDir: join(import.meta.dir, "..", "scripts", "git-shim"),
        realGit: resolveRealGit(process.env),
        guardLogPath: gitGuardLog,
        ghConfigDir,
      }),
    },
  );
  active?.set(lane.lane_id, proc);

  const log = Bun.file(logPath).writer();
  const streamToLog = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      log.write(chunk);
      await log.flush();
    }
  };

  try {
    const [exitCode] = await Promise.all([
      proc.exited,
      streamToLog(proc.stdout),
      streamToLog(proc.stderr),
    ]);
    return exitCode;
  } finally {
    active?.delete(lane.lane_id);
    await log.end();
  }
}

export type LaneOutcome = "completed" | "failed" | "pending" | "waiting_approval";

// import.meta.dir, not new URL(...).pathname: on Windows the latter yields
// "/C:/..." with a leading slash, which is not a resolvable path.
const EVIDENCE_SCRIPT = join(import.meta.dir, "..", "scripts", "check-evidence.ts");

async function hubJson(
  cfg: ConductorConfig,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(path, cfg.hubUrl), init);
  if (!res.ok) {
    throw new Error(`HUB ${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export function hubPost(
  cfg: ConductorConfig,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  return hubJson(cfg, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function checkEvidence(
  lane: DispatchableLane,
  beforeState?: GitState,
  gitGuardLog?: string,
): Promise<number> {
  const options = [
    ...(beforeState ? ["--before-state", JSON.stringify(beforeState)] : []),
    ...(gitGuardLog ? ["--git-guard-log", gitGuardLog] : []),
  ];
  const proc = Bun.spawn(
    [process.execPath, EVIDENCE_SCRIPT, ...options, lane.worktree_path, lane.lane_type, ...lane.owned_paths],
    { stdout: "pipe", stderr: "pipe" },
  );
  return proc.exited;
}

export async function runLane(
  cfg: ConductorConfig,
  lane: DispatchableLane,
  active?: Map<string, Bun.Subprocess>,
): Promise<LaneOutcome> {
  const beforeState = snapshotGitState(lane.worktree_path);
  const exitCode = await runAgent(cfg, lane, active);
  const evidenceExitCode = await checkEvidence(lane, beforeState, guardLogPath(cfg, lane));

  if (evidenceExitCode === 3) {
    await hubPost(cfg, `/lanes/${lane.lane_id}/messages`, {
      message_type: "FAILURE",
      question: `lane ${lane.lane_id} violated the agent's Git boundary`,
    });
    const result = await hubPost(cfg, `/lanes/${lane.lane_id}/result`, { exit_code: 30 });
    return result.status as LaneOutcome;
  }

  if (exitCode === 10) {
    await hubPost(cfg, `/lanes/${lane.lane_id}/messages`, {
      message_type: "APPROVAL_REQUEST",
      question: `lane ${lane.lane_id} exited 10 and is waiting for approval`,
    });
    return "waiting_approval";
  }

  if (exitCode === 0) {
    const log = Bun.file(join(cfg.logDir, `${lane.lane_id}.log`));
    const tailStart = Math.max(0, log.size - 64 * 1024);
    let tail = await log.slice(tailStart).text();
    if (tailStart > 0) {
      tail = tail.replace(/^[^\n]*(?:\n|$)/, "");
    }
    // Some agents print the brief into the transcript, so the template's own
    // example markers appear as real lines and used to match before anything
    // the agent said. A line that is verbatim brief text is an echo, never a
    // report; the agent's own marker carries a real question and never matches.
    // ponytail: a phrase match over the transcript, not a structured channel.
    // Give the lane a real side channel if this ever escalates the wrong lane.
    const echoed = new Set(buildPrompt(lane).split("\n").map((line) => line.trim()));
    const marker = tail
      .split("\n")
      .map((line) => line.trimEnd())
      .find(
        (line) =>
          /^[\t ]*(?:HOST VERIFICATION REQUIRED|APPROVAL REQUIRED)/i.test(line) &&
          !echoed.has(line.trim()),
      );
    const escalate = async (question: string): Promise<LaneOutcome> => {
      await hubPost(cfg, `/lanes/${lane.lane_id}/messages`, {
        message_type: "APPROVAL_REQUEST",
        question,
      });
      return "waiting_approval";
    };
    const markerQuestion = marker && `lane ${lane.lane_id} reported: "${marker.trim()}"`;

    // A worker that escalates still leaves a worktree worth checking, and a
    // sandboxed worker cannot run the checks itself. The conductor runs them
    // so a returning session finds evidence next to the question; the
    // worker's own question still wins the approval request.
    if (evidenceExitCode === 0) {
      const evidence = await runLaneChecks(lane.lane_id, lane.worktree_path, cfg.logDir);
      await hubPost(cfg, `/lanes/${lane.lane_id}/messages`, {
        message_type: "EVIDENCE",
        evidence_refs: evidence,
      });

      if (markerQuestion) return escalate(markerQuestion);

      if (evidence.overall === "failed") {
        const names = evidence.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.name)
          .join(", ");
        await hubPost(cfg, `/lanes/${lane.lane_id}/messages`, {
          message_type: "APPROVAL_REQUEST",
          question: `lane ${lane.lane_id} failed its lane checks: ${names}`,
        });
        return "waiting_approval";
      }

      if (evidence.overall === "unrunnable") {
        const reason = evidence.checks.find((check) => check.status === "unrunnable")?.error
          ?? "invalid lane-check manifest";
        await hubPost(cfg, `/lanes/${lane.lane_id}/messages`, {
          message_type: "APPROVAL_REQUEST",
          question: `lane ${lane.lane_id} could not run its lane checks: ${reason}`,
        });
        return "waiting_approval";
      }
    }

    if (markerQuestion) return escalate(markerQuestion);

    if (evidenceExitCode === 2) {
      return escalate(`lane ${lane.lane_id} exited 0 without producing changes and needs a decision`);
    }

    const result = await hubPost(cfg, `/lanes/${lane.lane_id}/result`, {
      exit_code: 0,
      evidence_passed: evidenceExitCode === 0,
    });
    return result.status as LaneOutcome;
  }

  // An unrecognized exit is an ordinary failure, not a policy violation.
  const result = await hubPost(cfg, `/lanes/${lane.lane_id}/result`, {
    exit_code: exitCode === 30 ? 30 : 20,
  });
  return result.status as LaneOutcome;
}

export interface Summary {
  completed: string[];
  waiting_approval: string[];
  failed: string[];
  errors: Array<{ lane_id: string; message: string }>;
  candidates_built: CandidateSummary[];
  candidates_failed: Array<CandidateSummary & { message: string }>;
  clean_runs: CleanRunSummary[];
  reader_runs: ReaderRunSummary[];
}

export interface CandidateSummary {
  plan_id: string;
  revision: number;
  plan_revision_id: string;
}

export interface CleanRunSummary extends CandidateSummary {
  status: "succeeded" | "failed" | "skipped";
  result_status?: CleanRunResult["status"];
  unmet_expectations: string[];
  message?: string;
}

export interface ReaderRunSummary extends CandidateSummary {
  status: ReaderResult["status"];
  message?: string;
}

interface DueCandidate {
  plan_id: string;
  revision: number;
  revision_id: string;
}

const CANDIDATE_SCRIPT = join(import.meta.dir, "..", "scripts", "build-candidate.ts");

async function runCandidateBuild(
  cfg: ConductorConfig,
  candidate: CandidateSummary,
): Promise<number> {
  await mkdir(cfg.logDir, { recursive: true });
  const logPath = join(cfg.logDir, `${candidate.plan_revision_id}.log`);
  await writeFile(logPath, "");
  const proc = Bun.spawn(
    [process.execPath, cfg.candidateScript ?? CANDIDATE_SCRIPT, candidate.plan_id],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HUB_URL: cfg.hubUrl },
    },
  );
  const log = Bun.file(logPath).writer();
  const streamToLog = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      log.write(chunk);
      await log.flush();
    }
  };

  try {
    const [exitCode] = await Promise.all([
      proc.exited,
      streamToLog(proc.stdout),
      streamToLog(proc.stderr),
    ]);
    return exitCode;
  } finally {
    await log.end();
  }
}

interface ConstructionRun {
  status?: unknown;
  detail?: { worktree_path?: unknown; base_commit?: unknown; message?: unknown };
}

async function recordCleanRun(
  cfg: ConductorConfig,
  candidate: CandidateSummary,
  construction: ConstructionRun,
): Promise<CleanRunSummary> {
  const opened = await hubPost(cfg, "/verification-runs", {
    plan_revision_id: candidate.plan_revision_id,
    layer: "clean_run",
  });
  if (typeof opened.id !== "string") throw new Error("HUB did not return a clean run id");

  if (construction.status !== "succeeded") {
    await hubPost(cfg, `/verification-runs/${opened.id}/result`, {
      status: "skipped",
      detail: {
        blocked_by_layer: "construction",
        construction_status: construction.status ?? "unknown",
      },
    });
    return { ...candidate, status: "skipped", unmet_expectations: [] };
  }

  const worktreePath = construction.detail?.worktree_path;
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    const message = "successful construction did not record a candidate worktree path";
    await hubPost(cfg, `/verification-runs/${opened.id}/result`, {
      status: "failed",
      detail: { runner_status: "unrunnable", error: message },
    });
    return { ...candidate, status: "failed", result_status: "unrunnable", unmet_expectations: [], message };
  }

  let result: CleanRunResult;
  try {
    result = await runCleanRun(worktreePath, cfg.logDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await hubPost(cfg, `/verification-runs/${opened.id}/result`, {
      status: "failed",
      detail: { runner_status: "unrunnable", error: message },
    });
    return { ...candidate, status: "failed", result_status: "unrunnable", unmet_expectations: [], message };
  }

  const status = result.status === "passed" ? "succeeded" : "failed";
  await hubPost(cfg, `/verification-runs/${opened.id}/result`, { status, detail: result });
  const unmetExpectations = result.expectations
    .filter((expectation) => !expectation.met)
    .map((expectation) => expectation.name);
  return {
    ...candidate,
    status,
    result_status: result.status,
    unmet_expectations: unmetExpectations,
    ...(result.error ? { message: result.error } : {}),
  };
}

async function recordReaderRun(
  cfg: ConductorConfig,
  candidate: CandidateSummary,
  construction: ConstructionRun,
  cleanRun: CleanRunSummary,
): Promise<ReaderRunSummary> {
  const opened = await hubPost(cfg, "/verification-runs", {
    plan_revision_id: candidate.plan_revision_id,
    layer: "reader",
  });
  if (typeof opened.id !== "string") throw new Error("HUB did not return a reader run id");

  const skip = async (blockedByLayer: "construction" | "clean_run") => {
    await hubPost(cfg, `/verification-runs/${opened.id}/result`, {
      status: "skipped",
      detail: { blocked_by_layer: blockedByLayer },
    });
    return { ...candidate, status: "skipped" as const };
  };
  if (construction.status !== "succeeded") return skip("construction");
  if (cleanRun.status !== "succeeded") return skip("clean_run");

  const worktreePath = construction.detail?.worktree_path;
  const baseCommit = construction.detail?.base_commit;
  if (typeof worktreePath !== "string" || worktreePath.length === 0 || typeof baseCommit !== "string" || baseCommit.length === 0) {
    const missing = [
      ...(typeof worktreePath !== "string" || worktreePath.length === 0 ? ["candidate worktree path"] : []),
      ...(typeof baseCommit !== "string" || baseCommit.length === 0 ? ["base commit"] : []),
    ];
    const message = `successful construction did not record a ${missing.join(" and ")}`;
    await hubPost(cfg, `/verification-runs/${opened.id}/result`, {
      status: "failed",
      detail: { error: message },
    });
    return { ...candidate, status: "failed", message };
  }

  const rejectedFindings = await hubJson(cfg, `/plans/${candidate.plan_id}/rejected-findings`);
  const result = await runReader(worktreePath, baseCommit, rejectedFindings as unknown as ReaderFinding[], cfg.logDir, cfg.agentBin);
  for (const finding of result.findings) {
    await hubPost(cfg, `/verification-runs/${opened.id}/findings`, finding);
  }
  await hubPost(cfg, `/verification-runs/${opened.id}/result`, { status: result.status, detail: result });
  return { ...candidate, status: result.status, ...(result.error ? { message: result.error } : {}) };
}

async function buildDueCandidates(
  cfg: ConductorConfig,
  summary: Summary,
  log: (line: string) => void,
): Promise<void> {
  const candidates = (await hubJson(cfg, "/candidates/due")) as unknown as DueCandidate[];
  for (const due of candidates) {
    const candidate: CandidateSummary = {
      plan_id: due.plan_id,
      revision: due.revision,
      plan_revision_id: due.revision_id,
    };
    try {
      const exitCode = await runCandidateBuild(cfg, candidate);
      const construction = await hubJson(
        cfg,
        `/verification-runs/latest?plan_revision_id=${candidate.plan_revision_id}&layer=construction`,
      ) as ConstructionRun | null;
      if (!construction) throw new Error("candidate builder did not record a construction run");
      if (exitCode === 0) {
        if (construction.status !== "succeeded") {
          throw new Error(`candidate builder exited 0 with construction status ${construction.status ?? "missing"}`);
        }
        summary.candidates_built.push(candidate);
        log(`${candidate.plan_id} r${candidate.revision}: candidate built`);
      } else {
        const message = typeof construction.detail?.message === "string"
          ? construction.detail.message
          : `candidate builder exited ${exitCode}`;
        summary.candidates_failed.push({ ...candidate, message });
        log(`${candidate.plan_id} r${candidate.revision}: candidate failed - ${message}`);
      }

      let cleanRun: CleanRunSummary;
      try {
        cleanRun = await recordCleanRun(cfg, candidate, construction);
        summary.clean_runs.push(cleanRun);
        log(`${candidate.plan_id} r${candidate.revision}: clean run ${cleanRun.status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanRun = { ...candidate, status: "failed", unmet_expectations: [], message };
        summary.clean_runs.push(cleanRun);
        log(`${candidate.plan_id} r${candidate.revision}: clean run error - ${message}`);
      }
      try {
        const readerRun = await recordReaderRun(cfg, candidate, construction, cleanRun);
        summary.reader_runs.push(readerRun);
        log(`${candidate.plan_id} r${candidate.revision}: reader run ${readerRun.status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.reader_runs.push({ ...candidate, status: "failed", message });
        log(`${candidate.plan_id} r${candidate.revision}: reader run error - ${message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.candidates_failed.push({ ...candidate, message });
      log(`${candidate.plan_id} r${candidate.revision}: candidate error - ${message}`);
    }
  }
}

interface Settled {
  lane_id: string;
  outcome: LaneOutcome | "error";
  message?: string;
}

// Sequential registration, parallel execution. Only the gate -> /start pair is
// serialized: that pair is not atomic in SQL, and running it one lane at a time
// is what makes a single conductor safe without SELECT ... FOR UPDATE.
export async function drain(
  cfg: ConductorConfig,
  active: Map<string, Bun.Subprocess> = new Map(),
  log: (line: string) => void = () => {},
): Promise<Summary> {
  const summary: Summary = {
    completed: [],
    waiting_approval: [],
    failed: [],
    errors: [],
    candidates_built: [],
    candidates_failed: [],
    clean_runs: [],
    reader_runs: [],
  };
  const running = new Map<string, Promise<Settled>>();

  for (;;) {
    const lanes = (await hubJson(cfg, "/lanes/dispatchable")) as unknown as DispatchableLane[];

    for (const lane of lanes) {
      if (running.has(lane.lane_id)) {
        continue;
      }
      const gate = (await hubJson(cfg, `/lanes/${lane.lane_id}/gate`)) as { allowed: boolean };
      if (!gate.allowed) {
        continue;
      }
      await hubPost(cfg, `/lanes/${lane.lane_id}/start`, {});
      log(`${lane.lane_id}: started`);

      running.set(
        lane.lane_id,
        runLane(cfg, lane, active).then(
          (outcome) => ({ lane_id: lane.lane_id, outcome }),
          (error: unknown) => ({
            lane_id: lane.lane_id,
            outcome: "error" as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }

    if (running.size === 0) {
      await buildDueCandidates(cfg, summary, log);
      return summary;
    }

    const settled = await Promise.race(running.values());
    running.delete(settled.lane_id);

    if (settled.outcome === "error") {
      summary.errors.push({ lane_id: settled.lane_id, message: settled.message ?? "unknown" });
      log(`${settled.lane_id}: error - ${settled.message}`);
    } else if (settled.outcome !== "pending") {
      // "pending" means HUB sent an exit-20 lane back for another attempt; it
      // reappears in /lanes/dispatchable on the next pass, so nothing to record.
      summary[settled.outcome].push(settled.lane_id);
      log(`${settled.lane_id}: ${settled.outcome}`);
    }
  }
}

export function defaultConfig(): ConductorConfig {
  // Lanes take minutes, so the pause between passes is not the notifier's 1 s.
  // 5 s is a starting point rather than a measurement: an idle pass costs one
  // GET /lanes/dispatchable, and the right number is something to observe.
  const configured = Number(process.env.LANEWARD_DRAIN_INTERVAL_MS);
  // PORT is where the hub listens, so it is also where the conductor should
  // look. Defaulting HUB_URL independently means changing PORT alone points the
  // conductor at nothing, and the only symptom is "Unable to connect" every
  // interval, which is what happened the first time these ran as real services.
  const port = Number(process.env.PORT);
  const defaultHub = `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 8787}`;
  return {
    hubUrl: process.env.HUB_URL ?? defaultHub,
    agentBin: process.env.LANEWARD_AGENT_BIN,
    logDir: defaultLogDir(),
    drainIntervalMs: Number.isFinite(configured) && configured > 0 ? configured : 5_000,
  };
}

// D-014 says approved lanes continue after Claude exits. `drain` is a single
// pass that returns when nothing is left running, so on its own it satisfies
// nothing: the operator ran it by hand and it stopped. This is the loop a
// service manager supervises.
//
// It never returns and never throws. A pass that fails is logged and the loop
// continues, because the most likely failure is an unreachable hub during its
// own restart, and exiting there would let Restart=on-failure turn a two-second
// outage into a permanently stopped conductor.
export async function runLoop(
  cfg: ConductorConfig,
  active: Map<string, Bun.Subprocess> = new Map(),
  log: (line: string) => void = () => {},
): Promise<never> {
  log(`conductor loop started, draining every ${cfg.drainIntervalMs} ms`);
  for (;;) {
    try {
      const summary = await drain(cfg, active, log);
      // An idle pass says nothing, and at this interval saying nothing is the
      // difference between a readable journal and a useless one.
      for (const error of summary.errors) log(`error: ${error.lane_id} - ${error.message}`);
      for (const candidate of summary.candidates_failed) {
        log(`candidate failed: ${candidate.plan_id} revision ${candidate.revision} - ${candidate.message}`);
      }
    } catch (error) {
      log(`drain pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await Bun.sleep(cfg.drainIntervalMs);
  }
}

// Ctrl-C is the expected way to stop a hung lane, so it has to be safe rather
// than merely documented: kill the children and hand every started lane back to
// HUB as an ordinary failure. HUB returns it to pending (or fails it on the
// third attempt), so the next run needs no manual cleanup.
export function installSignalHandlers(
  cfg: ConductorConfig,
  active: Map<string, Bun.Subprocess>,
): void {
  let handling = false;

  const onSignal = async (signal: string) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n${signal} received - stopping ${active.size} running lane(s)`);

    for (const [laneId, proc] of active) {
      proc.kill();
      try {
        await hubPost(cfg, `/lanes/${laneId}/result`, { exit_code: 20 });
        console.error(`${laneId}: handed back to HUB`);
      } catch (error) {
        console.error(`${laneId}: could not hand back - ${error}`);
      }
    }
    // SIGTERM is how a service manager asks for a stop, and handing the lanes
    // back is that stop succeeding, so it exits 0 and the unit reports inactive
    // rather than failed. Ctrl-C keeps its non-zero exit: interrupting a
    // one-shot drain is an abandoned run, not a completed one.
    process.exit(signal === "SIGTERM" ? 0 : 1);
  };

  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
}
