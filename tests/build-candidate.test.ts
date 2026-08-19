import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { candidateDatabaseName, candidateDbSuffix } from "../scripts/new-lane";
import { candidateDatabaseFromEnv, candidateLocation } from "../scripts/build-candidate";
import { isDisposableDatabase } from "../src/db";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const script = join(import.meta.dir, "../scripts/build-candidate.ts");

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function gitResult(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
}

function git(cwd: string, ...args: string[]): string {
  const result = gitResult(cwd, ...args);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function fixture() {
  // realpath, for the same reason scripts/new-lane.ts calls it on the worktree
  // root: on a Windows host whose user name exceeds eight characters, TMP is the
  // 8.3 short form (C:\Users\RUNNER~1\...) while git reports the long one, so a
  // path this fixture built and a path git printed compare unequal. It cannot
  // reproduce on a machine whose user name is short, which is why CI found it
  // and no local run ever could.
  const root = await realpath(await mkdtemp(join(tmpdir(), "laneward-candidate-")));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  roots.push(root);

  const initialized = Bun.spawnSync(["git", "init", "-q", repo], { stderr: "pipe" });
  if (initialized.exitCode !== 0) throw new Error(new TextDecoder().decode(initialized.stderr));
  git(repo, "config", "user.email", "test@test.local");
  git(repo, "config", "user.name", "test");
  await Bun.write(join(repo, "package.json"), JSON.stringify({ name: "candidate-fixture", private: true }));
  await Bun.write(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  await mkdir(worktrees, { recursive: true });

  async function commitLane(laneId: string, files: Record<string, string>) {
    const worktree = join(worktrees, laneId);
    git(repo, "worktree", "add", "-q", "-b", `lane/${laneId}`, worktree);
    for (const [path, text] of Object.entries(files)) await Bun.write(join(worktree, path), text);
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", `${laneId} work`);
    return worktree;
  }

  return { root, repo, worktrees, commitLane };
}

interface HubState {
  runs: Array<{ id: string; attempt: number; status: string; detail?: unknown }>;
  unresolvedApproval: boolean;
}

function serve(lanes: unknown[], state?: HubState) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/lanes") return Response.json(lanes);
      if (url.pathname === "/verification-runs/latest") {
        return Response.json(state?.runs.at(-1) ?? null);
      }
      if (url.pathname === "/pending") {
        return Response.json({
          waiting_approval: state?.unresolvedApproval
            ? [{ subject_kind: "plan_revision", plan_revision_id: "revision-1" }]
            : [],
          failed: [],
        });
      }
      if (url.pathname === "/verification-runs" && request.method === "POST" && state) {
        const run = { id: `run-${state.runs.length + 1}`, attempt: state.runs.length + 1, status: "running" };
        state.runs.push(run);
        return Response.json(run, { status: 201 });
      }
      const result = url.pathname.match(/^\/verification-runs\/(.+)\/result$/);
      if (result && request.method === "POST" && state) {
        const run = state.runs.find((item) => item.id === result[1]);
        if (!run) return new Response("not found", { status: 404 });
        Object.assign(run, await request.json());
        return Response.json(run);
      }
      if (url.pathname.endsWith("/approvals") && request.method === "POST" && state) {
        state.unresolvedApproval = true;
        return Response.json({ id: "approval" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server.url.href.replace(/\/$/, "");
}

async function build(
  repo: string,
  worktrees: string,
  planId: string,
  lanes: unknown[],
  options: { rebuild?: boolean; state?: HubState } = {},
) {
  const state = options.state ?? { runs: [], unresolvedApproval: false };
  const child = Bun.spawn(["bun", "run", script, planId, ...(options.rebuild ? ["--rebuild"] : [])], {
    cwd: repo,
    env: {
      ...process.env,
      HUB_URL: serve(lanes, state),
      LANE_REPO: repo,
      LANE_WORKTREE_ROOT: worktrees,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, state };
}

function lane(laneId: string, status: string, planId: string, revision: number, worktreePath: string) {
  return {
    lane_id: laneId,
    status,
    worktree_path: worktreePath,
    plan_revision_id: `revision-${revision}`,
    plan_id: planId,
    revision,
  };
}

test("the candidate database name is disposable and derived from its plan revision", () => {
  expect(candidateDbSuffix("Plan-One", 12)).toBe("_candidate_plan_one_r12_test");
  const name = candidateDatabaseName("a".repeat(63), "Plan-One", 12);
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  expect(name).toEndWith("_candidate_plan_one_r12_test");
  expect(isDisposableDatabase(`postgres://127.0.0.1/${name}`)).toBe(true);
});

test("candidate cleanup accepts only a database with the shared candidate suffix", () => {
  const suffix = candidateDbSuffix("plan-one", 2);
  expect(candidateDatabaseFromEnv(`DATABASE_URL=postgres://localhost/hub${suffix}`, "plan-one", 2))
    .toBe(`hub${suffix}`);
  expect(candidateDatabaseFromEnv("DATABASE_URL=postgres://localhost/laneward", "plan-one", 2))
    .toBeUndefined();
});

test("a plan with no lanes is refused before repository inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "laneward-empty-candidate-"));
  const worktrees = join(root, "worktrees");
  roots.push(root);

  const result = await build(root, worktrees, "empty-plan", []);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("the plan has no lanes");
  expect(result.state.runs).toHaveLength(0);
  expect(existsSync(worktrees)).toBe(false);
});

test("an incomplete newest revision is refused without creating a candidate", async () => {
  const { repo, worktrees } = await fixture();
  const planId = "refused-plan";
  const lanes = [
    lane("lane-a", "completed", planId, 2, join(worktrees, "lane-a")),
    lane("lane-b", "running", planId, 2, join(worktrees, "lane-b")),
  ];

  const result = await build(repo, worktrees, planId, lanes);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("lane-a: completed");
  expect(result.stderr).toContain("lane-b: running");
  expect(result.state.runs).toHaveLength(0);
  expect(existsSync(join(worktrees, `candidate-${planId}-r2`))).toBe(false);
  expect(git(repo, "branch", "--list", `integration/${planId}-r2`)).toBe("");
  expect(git(repo, "status", "--porcelain")).toBe("");
});

test("a completed newest revision produces a branch containing every lane commit", async () => {
  const { repo, worktrees, commitLane } = await fixture();
  const planId = "ready-plan";
  const laneA = await commitLane("lane-a", { "a.txt": "a\n" });
  const laneB = await commitLane("lane-b", { "b.txt": "b\n" });
  const lanes = [
    lane("old-lane", "running", planId, 1, join(worktrees, "old-lane")),
    lane("lane-b", "completed", planId, 2, laneB),
    lane("lane-a", "completed", planId, 2, laneA),
  ];

  const result = await build(repo, worktrees, planId, lanes);
  const branch = `integration/${planId}-r2`;

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Branch: ${branch}`);
  expect(gitResult(repo, "merge-base", "--is-ancestor", "lane/lane-a", branch).exitCode).toBe(0);
  expect(gitResult(repo, "merge-base", "--is-ancestor", "lane/lane-b", branch).exitCode).toBe(0);
  // Trimmed, not literal: a checkout under core.autocrlf rewrites the line
  // ending, and the point here is that the merged tree carries both lanes'
  // files, not which newline this host writes.
  expect((await Bun.file(join(worktrees, `candidate-${planId}-r2`, "a.txt")).text()).trim()).toBe("a");
  expect((await Bun.file(join(worktrees, `candidate-${planId}-r2`, "b.txt")).text()).trim()).toBe("b");
});

test("a plain build records its attempt and a second plain build is refused before repository changes", async () => {
  const { repo, worktrees, commitLane } = await fixture();
  const planId = "plain-recorded";
  const laneWorktree = await commitLane("lane-a", { "lane.txt": "built\n" });
  const lanes = [lane("lane-a", "completed", planId, 1, laneWorktree)];

  const first = await build(repo, worktrees, planId, lanes);
  const second = await build(repo, worktrees, planId, lanes, { state: first.state });

  expect(first.exitCode).toBe(0);
  expect(first.state.runs).toHaveLength(1);
  expect(first.state.runs[0]).toMatchObject({ attempt: 1, status: "succeeded" });
  expect(second.exitCode).toBe(1);
  expect(second.stderr).toContain("a construction attempt is already recorded");
  expect(second.stderr).toContain("--rebuild");
  expect(first.state.runs).toHaveLength(1);
});

test("a merge conflict leaves the candidate and conflicted state in place", async () => {
  const { repo, worktrees, commitLane } = await fixture();
  const planId = "conflict-plan";
  const laneA = await commitLane("lane-a", { "shared.txt": "from a\n" });
  const laneB = await commitLane("lane-b", { "shared.txt": "from b\n" });
  const lanes = [
    lane("lane-b", "completed", planId, 3, laneB),
    lane("lane-a", "completed", planId, 3, laneA),
  ];

  const result = await build(repo, worktrees, planId, lanes);
  const branch = `integration/${planId}-r3`;
  const candidate = join(worktrees, `candidate-${planId}-r3`);

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("merge of lane/lane-b");
  expect(result.stderr).toContain("Debris was left in place");
  expect(result.state.runs).toHaveLength(1);
  expect(result.state.runs[0]).toMatchObject({
    attempt: 1,
    status: "failed",
    detail: { step: "merge of lane/lane-b" },
  });
  expect(result.state.unresolvedApproval).toBe(true);
  expect(existsSync(candidate)).toBe(true);
  expect(git(repo, "branch", "--list", branch)).toContain(branch);
  expect(git(candidate, "status", "--porcelain")).toContain("UU shared.txt");
  expect(gitResult(candidate, "rev-parse", "--verify", "MERGE_HEAD").exitCode).toBe(0);
});

test("--rebuild refuses an unresolved approval without changing the old candidate", async () => {
  const { repo, worktrees, commitLane } = await fixture();
  const planId = "rebuild-open-approval";
  const laneWorktree = await commitLane("lane-a", { "lane.txt": "new\n" });
  const lanes = [lane("lane-a", "completed", planId, 1, laneWorktree)];
  const location = candidateLocation(worktrees, planId, 1);
  git(repo, "worktree", "add", "-q", "-b", location.branch, location.worktreePath);
  await Bun.write(join(location.worktreePath, "old.txt"), "old\n");
  const state: HubState = {
    runs: [{ id: "run-1", attempt: 1, status: "failed" }],
    unresolvedApproval: true,
  };

  const result = await build(repo, worktrees, planId, lanes, { rebuild: true, state });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("unresolved approval");
  expect(existsSync(join(location.worktreePath, "old.txt"))).toBe(true);
  expect(state.runs).toHaveLength(1);
});

test("--rebuild refuses when the newest construction attempt succeeded", async () => {
  const { repo, worktrees, commitLane } = await fixture();
  const planId = "rebuild-succeeded";
  const laneWorktree = await commitLane("lane-a", { "lane.txt": "new\n" });
  const state: HubState = {
    runs: [{ id: "run-1", attempt: 1, status: "succeeded" }],
    unresolvedApproval: false,
  };

  const result = await build(repo, worktrees, planId, [lane("lane-a", "completed", planId, 1, laneWorktree)], {
    rebuild: true,
    state,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("latest construction attempt is succeeded");
  expect(state.runs).toHaveLength(1);
});

test("--rebuild after approval removes the old candidate and records a new attempt", async () => {
  const { repo, worktrees, commitLane } = await fixture();
  const planId = "rebuild-resolved";
  const laneWorktree = await commitLane("lane-a", { "lane.txt": "new\n" });
  const lanes = [lane("lane-a", "completed", planId, 1, laneWorktree)];
  const location = candidateLocation(worktrees, planId, 1);
  git(repo, "worktree", "add", "-q", "-b", location.branch, location.worktreePath);
  await Bun.write(join(location.worktreePath, "old.txt"), "old\n");
  const state: HubState = {
    runs: [{ id: "run-1", attempt: 1, status: "failed" }],
    unresolvedApproval: false,
  };

  const result = await build(repo, worktrees, planId, lanes, { rebuild: true, state });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Removing worktree: ${location.worktreePath}`);
  expect(result.stdout).toContain(`Removing branch: ${location.branch}`);
  expect(existsSync(join(location.worktreePath, "old.txt"))).toBe(false);
  // Trimmed for the same reason as the merged-tree assertion above: a checkout
  // under core.autocrlf rewrites the line ending.
  expect((await Bun.file(join(location.worktreePath, "lane.txt")).text()).trim()).toBe("new");
  expect(state.runs.map((run) => ({ attempt: run.attempt, status: run.status }))).toEqual([
    { attempt: 1, status: "failed" },
    { attempt: 2, status: "succeeded" },
  ]);
});
