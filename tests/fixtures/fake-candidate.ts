import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const planId = process.argv[2];
const hubUrl = process.env.HUB_URL!;
const lanes = await fetch(`${hubUrl}/lanes`).then((response) => response.json()) as any[];
const lane = lanes.find((item) => item.plan_id === planId);
const latest = await fetch(
  `${hubUrl}/verification-runs/latest?plan_revision_id=${lane.plan_revision_id}&layer=construction`,
).then((response) => response.json());
if (latest) process.exit(1);

const run = await fetch(`${hubUrl}/verification-runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ plan_revision_id: lane.plan_revision_id, layer: "construction" }),
}).then((response) => response.json()) as { id: string };

if (planId.includes("failure")) {
  await fetch(`${hubUrl}/verification-runs/${run.id}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: "failed",
      detail: { step: "merge of lane/failure", message: "merge conflict" },
    }),
  });
  await fetch(`${hubUrl}/plan-revisions/${lane.plan_revision_id}/approvals`, { method: "POST" });
  console.error("The candidate could not be assembled.");
  process.exit(2);
}

const worktreePath = await mkdtemp(join(tmpdir(), `candidate-${planId}-`));
async function git(args: string[]) {
  const result = Bun.spawnSync(["git", "-C", worktreePath, ...args]);
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

await mkdir(join(worktreePath, ".laneward"));
await mkdir(join(worktreePath, "tests"));
await mkdir(join(worktreePath, "src"));
await writeFile(join(worktreePath, "fake-clean-run.ts"), "console.log('clean-run-observed'); setInterval(() => {}, 1000);\n");
await writeFile(join(worktreePath, ".laneward", "project.json"), JSON.stringify({
  version: 1,
  clean_run: {
    shell: { [process.platform]: ["bash", "-lc"] },
    environment: {},
    start: "exec bun fake-clean-run.ts",
    // Same reason as tests/lane-checks.test.ts, doubled: this one starts inside
    // a conductor pass with the rest of the suite running, and 5 s was observed
    // closing before the process printed on a loaded host. The drain test
    // failed once at 5.5 s and passed alone. Its callers budget 45 s, so this fits
    // twice over, which the two-candidate cases need.
    observation_window_ms: 10_000,
    expectations: [{
      name: "clean run output",
      must_appear: planId.includes("clean-miss") ? "never-observed" : "clean-run-observed",
    }],
  },
  reader: { test_paths: ["tests"] },
}));
await writeFile(join(worktreePath, "tests", "subject.test.ts"), "export const testMarker = 'base-test';\n");
await writeFile(join(worktreePath, "src", "context.ts"), "export const sourceMarker = 'base-source';\n");
await git(["init"]);
await git(["add", "."]);
await git(["-c", "user.name=Reader", "-c", "user.email=reader@example.test", "commit", "-m", "base"]);
const baseCommit = await git(["rev-parse", "HEAD"]);
await writeFile(join(worktreePath, "tests", "subject.test.ts"), "export const testMarker = 'changed-test-diff';\n");
await writeFile(join(worktreePath, "src", "context.ts"), "export const sourceMarker = 'changed-source-diff';\n");
await git(["add", "."]);
await git(["-c", "user.name=Reader", "-c", "user.email=reader@example.test", "commit", "-m", "candidate"]);
await writeFile(join(worktreePath, ".output"), `\`\`\`json\n${JSON.stringify({ findings: planId.includes("no-findings") ? [] : [{
  finding: "reader concern", subject: "test_diff", out_of_change: false,
  locations: [{ path: "tests/subject.test.ts", side: "head", start_line: 1, end_line: 1 }],
}] })}\n\`\`\``);
if (planId.includes("reader-failed")) await writeFile(join(worktreePath, ".exit-code"), "7");

await fetch(`${hubUrl}/verification-runs/${run.id}/result`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    status: "succeeded",
    detail: {
      branch: `integration/${planId}-r1`,
      worktree_path: worktreePath,
      ...(planId.includes("missing-reader-input") ? {} : { base_commit: baseCommit }),
      database_name: `laneward_candidate_${planId}_r1_test`,
    },
  }),
});
console.log("The candidate is ready; this prose is not an API.");
