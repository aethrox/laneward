import { extname } from "node:path";

// Laneward dispatches work to an agent, and until now that agent was Codex by
// construction: the flags `exec -C <dir> -s <mode> -m <model>` were written into
// the two places that spawn one. Everything around them is already
// agent-agnostic -- the exit-code contract, buildWorkerEnv's credential
// stripping, the git shim, check-evidence, the owned-path gate -- so the
// coupling was two argument arrays, not a design.
//
// An agent is declared as a command template per sandbox mode, with {worktree}
// and {model} substituted. Argument arrays rather than a command string, for the
// same reason every other spawn here uses them: paths on the Windows host
// contain spaces, and a string is where that turns into a defect.

export type AgentMode = "write" | "read_only";

export const AGENT_ENV_VAR: Record<AgentMode, string> = {
  write: "LANEWARD_AGENT_WRITE",
  read_only: "LANEWARD_AGENT_READ",
};

// Codex remains the default so an existing install keeps working untouched.
const CODEX_TEMPLATE: Record<AgentMode, string[]> = {
  write: ["{bin}", "exec", "-C", "{worktree}", "-s", "workspace-write", "-m", "{model}"],
  read_only: ["{bin}", "exec", "-C", "{worktree}", "-s", "read-only", "-m", "{model}"],
};

export interface AgentSubstitutions {
  worktree: string;
  model: string;
}

function parseTemplate(raw: string, envVar: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${envVar} must be a JSON array of arguments`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === "string")) {
    throw new Error(`${envVar} must be a JSON array of arguments`);
  }
  return parsed as string[];
}

/**
 * The template for a mode, or null when the operator declared a custom agent and
 * gave no read-only command.
 *
 * That case is deliberately not an error and deliberately not a fallback to the
 * write command. The read-only mode is what stops the reader from editing the
 * candidate it is reviewing, and an agent with no way to express it cannot be
 * given that job. Laneward disables the layer rather than running it unconfined,
 * because confinement here is the agent's to provide and Laneward cannot verify
 * a claim that it did.
 */
export function agentTemplate(
  mode: AgentMode,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const declared = env[AGENT_ENV_VAR[mode]];
  if (declared && declared.length > 0) return parseTemplate(declared, AGENT_ENV_VAR[mode]);

  // A custom write agent with no read-only counterpart disables the reader. If
  // neither is set, this is a stock Codex install and both defaults apply.
  const customWrite = env[AGENT_ENV_VAR.write];
  if (mode === "read_only" && customWrite && customWrite.length > 0) return null;

  return CODEX_TEMPLATE[mode];
}

/**
 * The argv to spawn. `bin` is only consulted for the built-in Codex template;
 * a declared template owns its own argv[0], because overriding it would make
 * CODEX_BIN silently rewrite a command the operator wrote deliberately.
 */
export function agentCommand(
  mode: AgentMode,
  subs: AgentSubstitutions,
  env: Record<string, string | undefined> = process.env,
  bin?: string,
): string[] | null {
  const template = agentTemplate(mode, env);
  if (!template) return null;

  const resolvedBin = bin ?? env.CODEX_BIN ?? "codex";
  const argv = template.map((part) =>
    part
      .replaceAll("{bin}", resolvedBin)
      .replaceAll("{worktree}", subs.worktree)
      .replaceAll("{model}", subs.model),
  );

  // A .ts entry point is not executable on its own. The test fixtures are
  // TypeScript, and so is anything an operator points at without a shebang.
  return extname(argv[0]) === ".ts" ? [process.execPath, ...argv] : argv;
}
