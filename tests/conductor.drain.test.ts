import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../src/app";
import { sql } from "../src/db";
import { drain, type ConductorConfig } from "../src/conductor";

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex.ts");
const FAKE_CANDIDATE = join(import.meta.dir, "fixtures", "fake-candidate.ts");
const server = Bun.serve({ port: 0, fetch: app.fetch });

afterAll(() => server.stop(true));

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals, verification_runs, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function config(): Promise<ConductorConfig> {
  return {
    hubUrl: server.url.href,
    codexBin: FAKE_CODEX,
    candidateScript: FAKE_CANDIDATE,
    logDir: await mkdtemp(join(tmpdir(), "conductor-logs-")),
    drainIntervalMs: 0,
  };
}

async function completedPlan(planId: string) {
  await sql`INSERT INTO plans (plan_id, title) VALUES (${planId}, ${planId})`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES (${planId}, 1, ${{ objective: "test" }}) RETURNING id
  `;
  await sql`
    INSERT INTO lanes
      (lane_id, owned_paths, lane_type, status, worktree_path, original_brief, plan_revision_id)
    VALUES (${`${planId}-lane`}, ${sql.array([`${planId}.ts`], "text")}, 'write',
      'completed', ${tmpdir()}, 'done', ${revision.id})
  `;
  return revision.id as string;
}

// Registers a pending lane and returns its id. `exitCode` drives the fake codex.
async function registerLane(opts: {
  laneId: string;
  ownedPaths?: string[];
  dependsOn?: string[];
  exitCode?: number;
}): Promise<string> {
  const ownedPaths = opts.ownedPaths ?? [`${opts.laneId}.txt`];
  const worktree = await mkdtemp(join(tmpdir(), "conductor-wt-"));
  Bun.spawnSync(["git", "init", "-q", worktree]);
  await writeFile(
    join(worktree, ".git", "info", "exclude"),
    ".prompt\n.exit-code\n.sleep\n",
  );
  await writeFile(join(worktree, ownedPaths[0]), "change");
  if (opts.exitCode !== undefined) {
    await writeFile(join(worktree, ".exit-code"), String(opts.exitCode));
  }

  const res = await fetch(new URL("/lanes", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: opts.laneId,
      owned_paths: ownedPaths,
      lane_type: "write",
      model: "terra",
      depends_on: opts.dependsOn ?? [],
      worktree_path: worktree,
      original_brief: `brief for ${opts.laneId}`,
    }),
  });
  expect(res.status).toBe(201);
  return opts.laneId;
}

test("drain runs two independent lanes and reports both completed", async () => {
  const cfg = await config();
  await registerLane({ laneId: "alpha" });
  await registerLane({ laneId: "beta" });

  const summary = await drain(cfg);

  expect(summary.completed.sort()).toEqual(["alpha", "beta"]);
  expect(summary.failed).toEqual([]);
  expect(summary.waiting_approval).toEqual([]);
});

test("drain runs a dependent lane only after its dependency completes", async () => {
  const cfg = await config();
  await registerLane({ laneId: "first" });
  await registerLane({ laneId: "second", dependsOn: ["first"] });

  const summary = await drain(cfg);

  expect(summary.completed.sort()).toEqual(["first", "second"]);
});

test("drain leaves a lane that never opens its gate untouched", async () => {
  const cfg = await config();
  await registerLane({ laneId: "never-registered" });
  await sql`UPDATE lanes SET status = 'running' WHERE lane_id = 'never-registered'`;
  await registerLane({ laneId: "blocked", dependsOn: ["never-registered"] });

  const summary = await drain(cfg);

  expect(summary).toMatchObject({ completed: [], failed: [], waiting_approval: [] });
  const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = 'blocked'`;
  expect(lane.status).toBe("pending");
});

test("drain retries an exit 20 lane three times, then reports it failed", async () => {
  const cfg = await config();
  await registerLane({ laneId: "flaky", exitCode: 20 });

  const summary = await drain(cfg);

  expect(summary.failed).toEqual(["flaky"]);
  const [lane] = await sql`SELECT attempt_count FROM lanes WHERE lane_id = 'flaky'`;
  expect(lane.attempt_count).toBe(3);
});

test("drain parks an exit 10 lane and finishes the others", async () => {
  const cfg = await config();
  await registerLane({ laneId: "asks", exitCode: 10 });
  await registerLane({ laneId: "works" });

  const summary = await drain(cfg);

  expect(summary.waiting_approval).toEqual(["asks"]);
  expect(summary.completed).toEqual(["works"]);
});

test("drain resumes an approved lane with the decision in its prompt", async () => {
  const cfg = await config();
  await registerLane({ laneId: "asks", exitCode: 10 });
  await drain(cfg);

  const [approval] = await sql`SELECT id FROM approvals WHERE lane_id = 'asks'`;
  await fetch(new URL(`/approvals/${approval.id}`, server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolved_by: "human", decision: "yes, proceed with B" }),
  });
  const [lane] = await sql`SELECT worktree_path FROM lanes WHERE lane_id = 'asks'`;
  await writeFile(join(lane.worktree_path, ".exit-code"), "0");

  const summary = await drain(cfg);

  expect(summary.completed).toEqual(["asks"]);
  const prompt = await Bun.file(join(lane.worktree_path, ".prompt")).text();
  expect(prompt).toContain("brief for asks");
  expect(prompt).toContain("yes, proceed with B");
});

test("drain records a lane whose HUB call failed and keeps going", async () => {
  const cfg = await config();
  await registerLane({ laneId: "good" });
  await registerLane({ laneId: "vanishes" });

  // Make only this lane's result post fail, so its run throws while the other
  // lane finishes normally.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("/lanes/vanishes/result")) {
      return new Response("boom", { status: 500 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const summary = await drain(cfg);
    expect(summary.completed).toEqual(["good"]);
    expect(summary.errors.map((e) => e.lane_id)).toEqual(["vanishes"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The three tests below each run a real clean run per candidate, and one
// observation window alone is 10 s, so bun's 5 s default budget would decide
// them before their assertions do. The two-candidate cases need room for two.
test("drain reports a built candidate without parsing the builder's prose", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-success");

  const summary = await drain(cfg);

  expect(summary.candidates_built).toEqual([{
    plan_id: "candidate-success",
    revision: 1,
    plan_revision_id: revisionId,
  }]);
  const [run] = await sql`
    SELECT attempt, status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'construction'
  `;
  // Read before asserting: bun 1.3.14's toMatchObject overwrites every value an
  // asymmetric matcher matched with the matcher itself, so run.detail's paths
  // are `{}` by the time the assertion below returns.
  const candidateWorktree = (run.detail as { worktree_path: string }).worktree_path;
  expect(run).toMatchObject({
    attempt: 1,
    status: "succeeded",
    detail: {
      branch: "integration/candidate-success-r1",
      worktree_path: expect.any(String),
      base_commit: expect.any(String),
      database_name: "laneward_candidate_candidate-success_r1_test",
    },
  });
  expect(summary.clean_runs).toEqual([expect.objectContaining({
    plan_revision_id: revisionId,
    status: "succeeded",
    result_status: "passed",
    unmet_expectations: [],
  })]);
  expect(summary.reader_runs).toEqual([expect.objectContaining({
    plan_revision_id: revisionId,
    status: "succeeded",
  })]);
  const findings = await (await fetch(new URL(`/plan-revisions/${revisionId}/findings`, server.url))).json();
  expect(findings).toContainEqual(expect.objectContaining({
    finding: "reader concern",
    subject: "test_diff",
    locations: [{ path: "tests/subject.test.ts", side: "head", start_line: 1, end_line: 1 }],
  }));
  expect(await Bun.file(join(candidateWorktree, ".prompt")).exists()).toBe(true);
  const candidateLog = await Bun.file(join(cfg.logDir, `${revisionId}.log`)).text();
  expect(candidateLog).toContain("this prose is not an API");
  expect(candidateLog).not.toContain("Branch:");
}, 45_000);

test("a failed candidate records the failure, raises approval, and does not fail a lane", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-failure");

  const summary = await drain(cfg);

  expect(summary.failed).toEqual([]);
  expect(summary.errors).toEqual([]);
  expect(summary.candidates_failed).toEqual([{
    plan_id: "candidate-failure",
    revision: 1,
    plan_revision_id: revisionId,
    message: "merge conflict",
  }]);
  const [run] = await sql`
    SELECT status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'construction'
  `;
  expect(run).toMatchObject({
    status: "failed",
    detail: { step: "merge of lane/failure", message: "merge conflict" },
  });
  const pending = await (await fetch(new URL("/pending", server.url))).json();
  expect(pending.waiting_approval).toContainEqual(expect.objectContaining({
    subject_kind: "plan_revision",
    plan_revision_id: revisionId,
  }));
  const [cleanRun] = await sql`
    SELECT status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'clean_run'
  `;
  expect(cleanRun).toMatchObject({
    status: "skipped",
    detail: { blocked_by_layer: "construction", construction_status: "failed" },
  });
  expect(summary.clean_runs).toEqual([expect.objectContaining({ status: "skipped" })]);
  const [readerRun] = await sql`
    SELECT status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'reader'
  `;
  expect(readerRun).toMatchObject({ status: "skipped", detail: { blocked_by_layer: "construction" } });
  expect((await readdir(cfg.logDir)).some((name) => name.endsWith(".reader.log"))).toBe(false);
});

test("a failed clean run is shadow-only and leaves lanes and approvals untouched", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-clean-miss");
  const laterRevisionId = await completedPlan("candidate-z-clean-success");

  const summary = await drain(cfg);

  expect(summary.candidates_built).toHaveLength(2);
  expect(summary.clean_runs).toContainEqual(expect.objectContaining({
    status: "failed",
    result_status: "failed",
    unmet_expectations: ["clean run output"],
  }));
  expect(summary.clean_runs).toContainEqual(expect.objectContaining({
    plan_revision_id: laterRevisionId,
    status: "succeeded",
  }));
  const [lane] = await sql`SELECT status FROM lanes WHERE plan_revision_id = ${revisionId}`;
  expect(lane.status).toBe("completed");
  expect(await sql`SELECT id FROM approvals WHERE plan_revision_id = ${revisionId}`).toHaveLength(0);
  const [run] = await sql`
    SELECT status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'clean_run'
  `;
  expect(run).toMatchObject({
    status: "failed",
    detail: {
      status: "failed",
      expectations: [{ name: "clean run output", seen: false, met: false }],
    },
  });
  const [readerRun] = await sql`
    SELECT status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'reader'
  `;
  expect(readerRun).toMatchObject({ status: "skipped", detail: { blocked_by_layer: "clean_run" } });
  const [construction] = await sql`
    SELECT detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'construction'
  `;
  expect(await Bun.file(join((construction.detail as { worktree_path: string }).worktree_path, ".prompt")).exists()).toBe(false);
}, 45_000);

test("a reader with no findings closes as no_findings", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-no-findings");

  const summary = await drain(cfg);

  expect(summary.reader_runs).toEqual([expect.objectContaining({ plan_revision_id: revisionId, status: "no_findings" })]);
  expect(await sql`SELECT id FROM verification_findings WHERE verification_run_id IN (
    SELECT id FROM verification_runs WHERE plan_revision_id = ${revisionId} AND layer = 'reader'
  )`).toHaveLength(0);
  const [construction] = await sql`
    SELECT detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'construction'
  `;
  expect(await Bun.file(join((construction.detail as { worktree_path: string }).worktree_path, ".prompt")).exists()).toBe(true);
}, 45_000);

test("a failed reader records its result", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-reader-failed");

  const summary = await drain(cfg);

  expect(summary.reader_runs).toEqual([expect.objectContaining({ status: "failed", message: "reader exited 7" })]);
  const [run] = await sql`
    SELECT status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'reader'
  `;
  expect(run).toMatchObject({ status: "failed", detail: { status: "failed", error: "reader exited 7" } });
  const [construction] = await sql`
    SELECT detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'construction'
  `;
  expect(await Bun.file(join((construction.detail as { worktree_path: string }).worktree_path, ".prompt")).exists()).toBe(true);
}, 45_000);

test("the reader receives previously rejected findings", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-rejected-context");
  const [previous] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    VALUES (${revisionId}, 'reader', 1, 'running') RETURNING id
  `;
  const locations = [{ path: "tests/subject.test.ts", side: "head", start_line: 1, end_line: 1 }];
  const [finding] = await sql`
    INSERT INTO verification_findings (verification_run_id, finding, out_of_change, locations, subject)
    VALUES (${previous.id}, 'previous false positive', false, ${locations}, 'test_diff') RETURNING id
  `;
  await sql`UPDATE verification_findings SET state = 'rejected' WHERE id = ${finding.id}`;

  await drain(cfg);

  const [run] = await sql`
    SELECT detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'construction'
  `;
  expect(await Bun.file(join((run.detail as { worktree_path: string }).worktree_path, ".prompt")).exists()).toBe(true);
  const prompt = await Bun.file(join((run.detail as { worktree_path: string }).worktree_path, ".prompt")).text();
  expect(prompt).toContain("previous false positive");
}, 45_000);

test("a construction without reader input records a failed reader run", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-missing-reader-input");

  const summary = await drain(cfg);

  expect(summary.reader_runs).toEqual([expect.objectContaining({ status: "failed", message: expect.stringContaining("base commit") })]);
  const [run] = await sql`
    SELECT status, detail FROM verification_runs
    WHERE plan_revision_id = ${revisionId} AND layer = 'reader'
  `;
  expect(run).toMatchObject({ status: "failed", detail: { error: expect.stringContaining("base commit") } });
}, 45_000);

test("a reader error leaves the pass intact", async () => {
  const cfg = await config();
  const revisionId = await completedPlan("candidate-reader-error");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).includes(`/plans/candidate-reader-error/rejected-findings`)) throw new Error("reader exploded");
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const summary = await drain(cfg);
    expect(summary.candidates_built).toContainEqual(expect.objectContaining({ plan_revision_id: revisionId }));
    expect(summary.reader_runs).toContainEqual(expect.objectContaining({ plan_revision_id: revisionId, status: "failed", message: "reader exploded" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 45_000);

test("a candidate Hub error is isolated and later candidates still build", async () => {
  const cfg = await config();
  const brokenRevision = await completedPlan("candidate-a-failure-hub-error");
  const goodRevision = await completedPlan("candidate-z-success");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("/verification-runs/latest") && url.includes(brokenRevision)) {
      return new Response("boom", { status: 500 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const summary = await drain(cfg);
    expect(summary.candidates_failed).toContainEqual(expect.objectContaining({
      plan_revision_id: brokenRevision,
      // The hub error carries the query string too, so the path and the status
      // are asserted rather than the whole sentence.
      message: expect.stringMatching(/HUB GET \/verification-runs\/latest.* -> 500/),
    }));
    expect(summary.candidates_built).toContainEqual(expect.objectContaining({
      plan_revision_id: goodRevision,
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 45_000);
