import { extname } from "node:path";
import type { ModelTierName } from "./models";

// Laneward dispatches work to an agent, and until now that agent was Codex by
// construction: the flags `exec -C <dir> -s <mode> -m <model>` were written into
// the two places that spawn one. Everything around them is already
// agent-agnostic -- the exit-code contract, buildWorkerEnv's credential
// stripping, the git shim, check-evidence, the owned-path gate -- so the
// coupling was two argument arrays, not a design.
//
// An agent is declared as a command template per sandbox mode, with {bin},
// {worktree} and {model} substituted. Argument arrays rather than a command
// string, for the same reason every other spawn here uses them: paths on the
// Windows host contain spaces, and a string is where that turns into a defect.

export type AgentMode = "write" | "read_only";

export const AGENT_ENV_VAR: Record<AgentMode, string> = {
  write: "LANEWARD_AGENT_WRITE",
  read_only: "LANEWARD_AGENT_READ",
};

export const AGENT_PRESET_ENV_VAR = "LANEWARD_AGENT";
export const AGENT_BIN_ENV_VAR = "LANEWARD_AGENT_BIN";

export interface AgentPreset {
  bin: string;
  write: string[];
  read_only: string[] | null;
  models: Record<ModelTierName, string>;
}

// Verified by actually running both CLIs on this machine: the codex shape and
// the claude shape (including the claude read-only template's confinement,
// which was confirmed to refuse writes). Do not invent presets for other
// agents and do not alter these flags without re-verifying them the same way.
export const AGENT_PRESETS: Record<string, AgentPreset> = {
  codex: {
    bin: "codex",
    write: ["{bin}", "exec", "-C", "{worktree}", "-s", "workspace-write", "-m", "{model}"],
    read_only: ["{bin}", "exec", "-C", "{worktree}", "-s", "read-only", "-m", "{model}"],
    models: { fast: "gpt-5.6-luna", balanced: "gpt-5.6-terra", deep: "gpt-5.6-sol" },
  },
  claude: {
    bin: "claude",
    // `Bash(git *)` is denied because Laneward owns Git (D-008, D-011), and this
    // agent reaches for Git unprompted: left alone it runs `git status`, `git log`
    // and `git remote get-url` to orient itself, each carrying a `-c key=value`
    // prefix that the shim refuses by design. Every refusal counts as a Git
    // boundary violation, so a lane that had done its work correctly still
    // failed. Denying the calls at the agent is the fix; loosening the shim
    // would weaken the boundary for every agent to suit one.
    write: [
      "{bin}", "-p", "--permission-mode", "acceptEdits",
      "--disallowedTools", "Bash(git *)",
      "--model", "{model}",
    ],
    read_only: [
      "{bin}", "-p", "--permission-mode", "plan",
      "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash",
      "--model", "{model}",
    ],
    models: { fast: "haiku", balanced: "sonnet", deep: "opus" },
  },
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

const presetNames = () => Object.keys(AGENT_PRESETS).join(", ");

/**
 * The preset named by LANEWARD_AGENT, or null when none was named. Throws
 * when the name does not match a known preset, listing the ones that exist --
 * an unknown name is a typo the operator should see immediately, not a lane
 * that silently falls back to something else.
 */
export function activePreset(env: Record<string, string | undefined> = process.env): AgentPreset | null {
  const name = env[AGENT_PRESET_ENV_VAR];
  if (!name || name.length === 0) return null;
  const preset = AGENT_PRESETS[name];
  if (!preset) {
    throw new Error(`${AGENT_PRESET_ENV_VAR} must be one of: ${presetNames()} (got ${JSON.stringify(name)})`);
  }
  return preset;
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
 * a claim that it did. A preset whose own read_only is null (none of the two
 * built-in ones are) behaves the same way.
 *
 * There is no default agent: Laneward is not an OpenAI tool with others bolted
 * on, so falling back to Codex when nothing was declared would be a lie told
 * by a default. If neither LANEWARD_AGENT nor LANEWARD_AGENT_WRITE is set, this
 * throws naming both ways to declare one.
 */
export function agentTemplate(
  mode: AgentMode,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const declared = env[AGENT_ENV_VAR[mode]];
  if (declared && declared.length > 0) return parseTemplate(declared, AGENT_ENV_VAR[mode]);

  const preset = activePreset(env);
  if (preset) return preset[mode];

  // No preset active. A raw write template with no read-only counterpart
  // disables the reader; reaching this line for "write" means the write
  // template itself was never declared either, since it would have matched
  // `declared` above.
  const customWrite = env[AGENT_ENV_VAR.write];
  if (mode === "read_only" && customWrite && customWrite.length > 0) return null;

  throw new Error(
    `no agent declared: set ${AGENT_PRESET_ENV_VAR} to one of (${presetNames()}), ` +
      `or set ${AGENT_ENV_VAR.write} to a JSON argument array`,
  );
}

/**
 * The argv to spawn. `bin` is only consulted for a preset template; a declared
 * (raw JSON) template owns its own argv[0], because overriding it would make
 * LANEWARD_AGENT_BIN silently rewrite a command the operator wrote deliberately.
 */
export function agentCommand(
  mode: AgentMode,
  subs: AgentSubstitutions,
  env: Record<string, string | undefined> = process.env,
  bin?: string,
): string[] | null {
  const template = agentTemplate(mode, env);
  if (!template) return null;

  const resolvedBin = bin ?? env[AGENT_BIN_ENV_VAR] ?? activePreset(env)?.bin ?? "";
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
