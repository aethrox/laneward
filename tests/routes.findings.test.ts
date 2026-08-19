import { beforeEach, expect, test } from "bun:test";
import app from "../src/app";
import { sql } from "../src/db";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals, verification_runs, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function createPlan(planId = `findings-${crypto.randomUUID()}`) {
  const response = await app.request("/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan_id: planId, title: "Findings", content: {} }),
  });
  return { planId, ...(await response.json()) };
}

async function createRun(revisionId: string, layer = "reader") {
  const response = await app.request("/verification-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan_revision_id: revisionId, layer }),
  });
  return await response.json();
}

async function recordFinding(
  runId: string,
  finding = "A finding",
  outOfChange = false,
  subject = "test_diff",
  locations: unknown[] = [],
) {
  return app.request(`/verification-runs/${runId}/findings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ finding, out_of_change: outOfChange, subject, locations }),
  });
}

test("a reader finding starts open and is listed with its run", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  const recorded = await recordFinding(run.id, "Reader concern");
  expect(recorded.status).toBe(201);
  expect(await recorded.json()).toMatchObject({ finding: "Reader concern", state: "open" });

  const listed = await app.request(`/plan-revisions/${plan.revision_id}/findings`);
  expect(await listed.json()).toContainEqual(expect.objectContaining({
    verification_run_id: run.id, layer: "reader", attempt: 1, finding: "Reader concern", state: "open",
  }));
});

test("findings require an open reader run", async () => {
  const plan = await createPlan();
  const construction = await createRun(plan.revision_id, "construction");
  expect((await recordFinding(construction.id)).status).toBe(409);

  const reader = await createRun(plan.revision_id);
  await app.request(`/verification-runs/${reader.id}/result`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "succeeded" }),
  });
  expect((await recordFinding(reader.id)).status).toBe(409);
});

test("finding input and run ids are validated", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  for (const body of [{ finding: "" }, { finding: "valid", out_of_change: "yes" }]) {
    const response = await app.request(`/verification-runs/${run.id}/findings`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  expect((await recordFinding(crypto.randomUUID())).status).toBe(404);
});

test("an out-of-change finding is retained", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  await recordFinding(run.id, "Existing defect", true);
  const findings = await (await app.request(`/plan-revisions/${plan.revision_id}/findings`)).json();
  expect(findings).toContainEqual(expect.objectContaining({ finding: "Existing defect", out_of_change: true }));
});

test("findings retain locations on either diff side and their declared subject", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  const locations = [
    { path: "tests/reader.test.ts", side: "base", start_line: 10, end_line: 12 },
    { path: "src/reader.ts", side: "head", start_line: 31, end_line: 31 },
  ];
  const recorded = await recordFinding(run.id, "Deleted assertion", false, "test_diff", locations);
  expect(recorded.status).toBe(201);
  expect(await recorded.json()).toMatchObject({ locations, subject: "test_diff" });

  const listed = await (await app.request(`/plan-revisions/${plan.revision_id}/findings`)).json();
  expect(listed).toContainEqual(expect.objectContaining({ locations, subject: "test_diff" }));
});

test("findings may have no locations and either declared subject", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  for (const subject of ["test_diff", "source_context"]) {
    const recorded = await recordFinding(run.id, subject, false, subject);
    expect(recorded.status).toBe(201);
    expect(await recorded.json()).toMatchObject({ locations: [], subject });
  }
});

test("finding locations and subjects are validated by the route and database", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  for (const locations of [
    [{ side: "head", start_line: 1, end_line: 1 }],
    [{ path: "src/app.ts", side: "other", start_line: 1, end_line: 1 }],
    [{ path: "src/app.ts", side: "head", start_line: "one", end_line: 1 }],
  ]) {
    const response = await app.request(`/verification-runs/${run.id}/findings`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ finding: "invalid location", subject: "test_diff", locations }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid locations", field: "locations" });
  }
  const invalid = await recordFinding(run.id, "invalid subject", false, "other");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "invalid subject", field: "subject" });

  const finding = await (await recordFinding(run.id)).json();
  let error: unknown;
  try {
    await sql`UPDATE verification_findings SET subject = 'other' WHERE id = ${finding.id}`;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
});

for (const state of ["accepted", "rejected", "deferred"]) {
  test(`an open finding can be ${state}`, async () => {
    const plan = await createPlan();
    const run = await createRun(plan.revision_id);
    const finding = await (await recordFinding(run.id)).json();
    const adjudicated = await app.request(`/verification-findings/${finding.id}/adjudication`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, note: "reviewed" }),
    });
    expect(await adjudicated.json()).toMatchObject({ state, adjudication_note: "reviewed" });
  });
}

test("invalid finding state is refused by the route and database", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  const finding = await (await recordFinding(run.id)).json();
  const invalid = await app.request(`/verification-findings/${finding.id}/adjudication`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "closed" }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "invalid state", field: "state" });
  let error: unknown;
  try {
    await sql`UPDATE verification_findings SET state = 'closed' WHERE id = ${finding.id}`;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
});

test("adjudication notes and finding ids are validated", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  const finding = await (await recordFinding(run.id)).json();
  const note = await app.request(`/verification-findings/${finding.id}/adjudication`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "accepted", note: true }),
  });
  expect(note.status).toBe(400);
  const missing = await app.request(`/verification-findings/${crypto.randomUUID()}/adjudication`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "accepted" }),
  });
  expect(missing.status).toBe(404);
});

test("a finding is adjudicated once and retains the first decision", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  const finding = await (await recordFinding(run.id)).json();
  await app.request(`/verification-findings/${finding.id}/adjudication`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "accepted", note: "first" }),
  });
  const second = await app.request(`/verification-findings/${finding.id}/adjudication`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "rejected", note: "second" }),
  });
  expect(second.status).toBe(409);
  const [stored] = await sql`SELECT state, adjudication_note FROM verification_findings WHERE id = ${finding.id}`;
  expect(stored).toEqual({ state: "accepted", adjudication_note: "first" });
});

test("rejected findings follow the plan across revisions and retain reader context", async () => {
  const plan = await createPlan();
  const run = await createRun(plan.revision_id);
  const locations = [{ path: "tests/reader.test.ts", side: "base", start_line: 5, end_line: 5 }];
  for (const [text, state] of [["rejected", "rejected"], ["open", null], ["accepted", "accepted"], ["deferred", "deferred"]] as const) {
    const finding = await (await recordFinding(run.id, text, false, "source_context", locations)).json();
    if (state) await app.request(`/verification-findings/${finding.id}/adjudication`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }),
    });
  }
  const revision2 = await app.request(`/plans/${plan.planId}/revisions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: {} }),
  });
  expect(revision2.status).toBe(201);

  const rejected = await (await app.request(`/plans/${plan.planId}/rejected-findings`)).json();
  expect(rejected).toEqual([expect.objectContaining({
    finding: "rejected", state: "rejected", subject: "source_context", locations,
  })]);
});

// D-027: a reader that surfaced nothing sampled and came up empty, which is not
// a passed check. `succeeded` with no rows would read as one, so the state has
// to exist and has to be the reader's alone.
test("an empty reader report is no_findings, and no other layer may claim it", async () => {
  const plan = await createPlan();
  const reader = await createRun(plan.revision_id);
  const closed = await app.request(`/verification-runs/${reader.id}/result`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "no_findings" }),
  });
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({ status: "no_findings" });

  const cleanRun = await createRun(plan.revision_id, "clean_run");
  const refused = await app.request(`/verification-runs/${cleanRun.id}/result`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "no_findings" }),
  });
  expect(refused.status).toBe(409);
  const [stored] = await sql`SELECT status FROM verification_runs WHERE id = ${cleanRun.id}`;
  expect(stored.status).toBe("running");

  let error: unknown;
  try {
    await sql`UPDATE verification_runs SET status = 'no_findings' WHERE id = ${cleanRun.id}`;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
});

test("finding list routes refuse missing plans and revisions", async () => {
  expect((await app.request(`/plans/missing-${crypto.randomUUID()}/rejected-findings`)).status).toBe(404);
  expect((await app.request(`/plan-revisions/${crypto.randomUUID()}/findings`)).status).toBe(404);
});
