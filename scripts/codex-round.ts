// LANEWARD_AGENT_BIN seam: per-round `codex exec` flags without a per-lane
// schema field. Edit the flags below for the round, then run:
//   LANEWARD_AGENT=codex LANEWARD_AGENT_BIN=scripts/codex-round.ts bun run conductor
// The conductor writes the brief to this process's stdin and reads the lane log
// from its stdout, so the seam has to hand all three streams straight through.
// Without that, `codex exec` starts with no prompt and reports
// "No prompt provided via stdin", which the conductor scores as a failed lane.
const proc = Bun.spawn(
  [
    "codex",
    ...Bun.argv.slice(2),
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "model_reasoning_effort=high",
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);

process.exit(await proc.exited);

// This file has no imports, so the top-level await above makes it a script
// rather than a module unless something marks it as one.
export {};
