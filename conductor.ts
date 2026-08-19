import { defaultConfig, drain, installSignalHandlers, runLoop } from "./src/conductor";

const cfg = defaultConfig();
const active = new Map<string, Bun.Subprocess>();
installSignalHandlers(cfg, active);

// Without --loop this is what it has always been: one pass, a summary, an exit
// code. With it, the process is the thing a service manager supervises and the
// summary never prints, because there is no last pass to summarise.
if (process.argv.includes("--loop")) {
  await runLoop(cfg, active, (line) => console.log(line));
}

const summary = await drain(cfg, active, (line) => console.log(line));

console.log("\n--- summary ---");
console.log(`completed:        ${summary.completed.join(", ") || "-"}`);
console.log(`waiting approval: ${summary.waiting_approval.join(", ") || "-"}`);
console.log(`failed:           ${summary.failed.join(", ") || "-"}`);
for (const error of summary.errors) {
  console.log(`error: ${error.lane_id} - ${error.message}`);
}
for (const candidate of summary.candidates_built) {
  console.log(`candidate built: ${candidate.plan_id} revision ${candidate.revision}`);
}
for (const candidate of summary.candidates_failed) {
  console.log(`candidate failed: ${candidate.plan_id} revision ${candidate.revision} - ${candidate.message}`);
}
console.log(`logs: ${cfg.logDir}`);

if (summary.waiting_approval.length > 0 || summary.candidates_failed.length > 0) {
  console.log("\nResolve the approvals (POST /approvals/:id), then run this command again.");
}

process.exit(summary.failed.length > 0 || summary.errors.length > 0 ? 1 : 0);
