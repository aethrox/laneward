import { Hono } from "hono";
import { existsSync } from "node:fs";
import { sql } from "./db";
import { createDashboard } from "./dashboard";
import { checkGate, pathsOverlap } from "./gate";
import { isSlug } from "./slug";
import type { Lane } from "./types";

const app = new Hono();

const filled = (v: unknown) => typeof v === "string" && v.length > 0;
const stringArray = (v: unknown) =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
const actor = (v: unknown) => v === "human" || v === "claude";
const object = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
const verificationLayer = (v: unknown) =>
  v === "construction" || v === "clean_run" || v === "reader";
const verificationResult = (v: unknown) =>
  v === "succeeded" || v === "failed" || v === "skipped" || v === "no_findings";
const findingState = (v: unknown) =>
  v === "accepted" || v === "rejected" || v === "deferred";
const findingSubject = (v: unknown) => v === "test_diff" || v === "source_context";
const findingLocation = (v: any) =>
  object(v) && filled(v.path) && (v.side === "base" || v.side === "head") &&
  Number.isInteger(v.start_line) && Number.isInteger(v.end_line) &&
  v.start_line > 0 && v.end_line >= v.start_line;

// The DB constraints are the real guard; this one only names the bad field so a
// dispatcher typo is not a bare 500 the operator has to read journalctl to explain.
function invalidLaneField(body: any): string | null {
  // Not merely non-empty: the id becomes a worktree directory and a branch, so
  // a separator or `..` in it escapes the worktree root. See src/slug.ts.
  if (!isSlug(body?.lane_id)) return "lane_id";
  if (body.lane_type !== "write" && body.lane_type !== "read_review") return "lane_type";
  // A lane whose worktree does not exist is only discovered when the worker is
  // dispatched, and the worker's failure looks like the lane's own: the
  // conductor retries, every attempt dies, and the lane ends `failed` with a
  // message about a missing file rather than a missing lane.
  if (!filled(body.worktree_path) || !existsSync(body.worktree_path)) return "worktree_path";
  if (!stringArray(body.owned_paths) || body.owned_paths.length === 0) return "owned_paths";
  if (!filled(body.original_brief)) return "original_brief";
  if (body.model !== undefined && body.model !== "fast" && body.model !== "balanced" && body.model !== "deep") return "model";
  if (body.depends_on !== undefined && !stringArray(body.depends_on)) return "depends_on";
  return null;
}

app.post("/plans", async (c) => {
  const body = await c.req.json();
  // A slug for the same reason a lane_id is one: the integration candidate's
  // branch and worktree are named `integration/<plan_id>-r<n>` and
  // `candidate-<plan_id>-r<n>`, so a plan the hub accepts but no candidate can
  // be built for is a plan that dead-ends at integration.
  if (!isSlug(body?.plan_id)) return c.json({ error: "invalid plan_id", field: "plan_id" }, 400);
  if (!filled(body.title)) return c.json({ error: "invalid title", field: "title" }, 400);
  if (!object(body.content)) return c.json({ error: "invalid content", field: "content" }, 400);

  const [existing] = await sql`SELECT 1 FROM plans WHERE plan_id = ${body.plan_id}`;
  if (existing) return c.json({ error: "plan already exists" }, 409);

  await sql`INSERT INTO plans (plan_id, title) VALUES (${body.plan_id}, ${body.title})`;
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES (${body.plan_id}, 1, ${body.content})
    RETURNING id, revision
  `;
  return c.json({ plan_id: body.plan_id, revision: revision.revision, revision_id: revision.id }, 201);
});

app.post("/plans/:id/revisions", async (c) => {
  const planId = c.req.param("id");
  const body = await c.req.json();
  if (!object(body.content)) return c.json({ error: "invalid content", field: "content" }, 400);

  const [plan] = await sql`SELECT 1 FROM plans WHERE plan_id = ${planId}`;
  if (!plan) return c.json({ error: "plan not found" }, 404);
  const [revision] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    SELECT ${planId}, COALESCE(MAX(revision), 0) + 1, ${body.content}
    FROM plan_revisions WHERE plan_id = ${planId}
    RETURNING id, revision
  `;
  return c.json({ plan_id: planId, revision: revision.revision, revision_id: revision.id }, 201);
});

app.post("/plans/:id/revisions/:revision/approve", async (c) => {
  const planId = c.req.param("id");
  const revisionNumber = Number(c.req.param("revision"));
  const body = await c.req.json();
  if (!actor(body?.approved_by)) return c.json({ error: "invalid approved_by", field: "approved_by" }, 400);

  const [plan] = await sql`SELECT 1 FROM plans WHERE plan_id = ${planId}`;
  if (!plan) return c.json({ error: "plan not found" }, 404);
  const [revision] = await sql`
    SELECT id, approved_at FROM plan_revisions
    WHERE plan_id = ${planId} AND revision = ${revisionNumber}
  `;
  if (!revision) return c.json({ error: "plan revision not found" }, 404);
  if (revision.approved_at) return c.json({ error: "plan revision already approved" }, 409);

  await sql`
    UPDATE plan_revisions SET approved_at = now(), approved_by = ${body.approved_by}
    WHERE id = ${revision.id}
  `;
  return c.json({ plan_id: planId, revision: revisionNumber, revision_id: revision.id });
});

app.get("/plans/:id", async (c) => {
  const planId = c.req.param("id");
  const [plan] = await sql`SELECT plan_id, title, created_at FROM plans WHERE plan_id = ${planId}`;
  if (!plan) return c.json({ error: "plan not found" }, 404);
  const revisions = await sql`
    SELECT id, revision, content, created_at, approved_at, approved_by
    FROM plan_revisions WHERE plan_id = ${planId}
    ORDER BY revision DESC
  `;
  return c.json({ ...plan, revisions });
});

app.get("/candidates/due", async (c) => {
  const candidates = await sql`
    SELECT p.plan_id, r.revision, r.id AS revision_id
    FROM plans p
    JOIN plan_revisions r ON r.plan_id = p.plan_id
    JOIN lanes l ON l.plan_revision_id = r.id
    WHERE r.revision = (
      SELECT MAX(newest.revision) FROM plan_revisions newest
      WHERE newest.plan_id = p.plan_id
    )
      AND NOT EXISTS (
        SELECT 1 FROM verification_runs v
        WHERE v.plan_revision_id = r.id AND v.layer = 'construction'
      )
    GROUP BY p.plan_id, r.id, r.revision
    HAVING bool_and(l.status = 'completed')
    ORDER BY p.plan_id
  `;
  return c.json(candidates);
});

app.get("/verification-runs/latest", async (c) => {
  const revisionId = c.req.query("plan_revision_id");
  const layer = c.req.query("layer");
  if (!filled(revisionId)) return c.json({ error: "invalid plan_revision_id", field: "plan_revision_id" }, 400);
  if (!verificationLayer(layer)) return c.json({ error: "invalid layer", field: "layer" }, 400);
  const [run] = await sql`
    SELECT id, plan_revision_id, layer, attempt, status, detail, started_at, finished_at
    FROM verification_runs
    WHERE plan_revision_id::text = ${revisionId} AND layer = ${layer}
    ORDER BY attempt DESC LIMIT 1
  `;
  return c.json(run ?? null);
});

app.post("/verification-runs", async (c) => {
  const body = await c.req.json();
  if (!filled(body?.plan_revision_id)) {
    return c.json({ error: "invalid plan_revision_id", field: "plan_revision_id" }, 400);
  }
  if (!verificationLayer(body.layer)) return c.json({ error: "invalid layer", field: "layer" }, 400);
  const [revision] = await sql`SELECT id FROM plan_revisions WHERE id::text = ${body.plan_revision_id}`;
  if (!revision) return c.json({ error: "plan revision not found" }, 404);

  const [run] = await sql`
    INSERT INTO verification_runs (plan_revision_id, layer, attempt, status)
    SELECT ${revision.id}, ${body.layer}, COALESCE(MAX(attempt), 0) + 1, 'running'
    FROM verification_runs
    WHERE plan_revision_id = ${revision.id} AND layer = ${body.layer}
    RETURNING id, attempt
  `;
  return c.json(run, 201);
});

app.post("/verification-runs/:id/result", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (!verificationResult(body?.status)) return c.json({ error: "invalid status", field: "status" }, 400);
  if (body.detail !== undefined && body.detail !== null && !object(body.detail)) {
    return c.json({ error: "invalid detail", field: "detail" }, 400);
  }

  // The layer clause keeps a `no_findings` aimed at the wrong layer out of the
  // database CHECK, which would surface as a 500 the operator has to read the
  // log to explain.
  const [run] = await sql`
    UPDATE verification_runs
    SET status = ${body.status}, detail = ${body.detail ?? null}, finished_at = now()
    WHERE id::text = ${id} AND status = 'running'
      AND (${body.status} <> 'no_findings' OR layer = 'reader')
    RETURNING id, status, detail, finished_at
  `;
  if (run) return c.json(run);
  const [existing] = await sql`SELECT layer, status FROM verification_runs WHERE id::text = ${id}`;
  if (!existing) return c.json({ error: "verification run not found" }, 404);
  if (body.status === "no_findings" && existing.layer !== "reader") {
    return c.json({ error: "only a reader run can report no findings", field: "status" }, 409);
  }
  return c.json({ error: "verification run already closed" }, 409);
});

app.post("/verification-runs/:id/findings", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (!filled(body?.finding)) return c.json({ error: "invalid finding", field: "finding" }, 400);
  if (body.out_of_change !== undefined && typeof body.out_of_change !== "boolean") {
    return c.json({ error: "invalid out_of_change", field: "out_of_change" }, 400);
  }
  if (body.locations !== undefined && (!Array.isArray(body.locations) || !body.locations.every(findingLocation))) {
    return c.json({ error: "invalid locations", field: "locations" }, 400);
  }
  if (!findingSubject(body.subject)) return c.json({ error: "invalid subject", field: "subject" }, 400);

  const [finding] = await sql`
    INSERT INTO verification_findings (verification_run_id, finding, out_of_change, locations, subject)
    SELECT id, ${body.finding}, ${body.out_of_change ?? false}, ${body.locations ?? []}, ${body.subject}
    FROM verification_runs
    WHERE id::text = ${id} AND layer = 'reader' AND status = 'running'
    RETURNING id, verification_run_id, finding, out_of_change, state, raised_at,
              adjudicated_at, adjudication_note, locations, subject
  `;
  if (finding) return c.json(finding, 201);

  const [run] = await sql`SELECT layer, status FROM verification_runs WHERE id::text = ${id}`;
  if (!run) return c.json({ error: "verification run not found" }, 404);
  if (run.layer !== "reader") return c.json({ error: "verification run is not a reader run" }, 409);
  return c.json({ error: "verification run already closed" }, 409);
});

app.post("/verification-findings/:id/adjudication", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (!findingState(body?.state)) return c.json({ error: "invalid state", field: "state" }, 400);
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return c.json({ error: "invalid note", field: "note" }, 400);
  }

  const [finding] = await sql`
    UPDATE verification_findings
    SET state = ${body.state}, adjudicated_at = now(), adjudication_note = ${body.note ?? null}
    WHERE id::text = ${id} AND state = 'open'
    RETURNING id, state, adjudicated_at, adjudication_note
  `;
  if (finding) return c.json(finding);
  const [existing] = await sql`SELECT 1 FROM verification_findings WHERE id::text = ${id}`;
  return existing
    ? c.json({ error: "verification finding already adjudicated" }, 409)
    : c.json({ error: "verification finding not found" }, 404);
});

app.get("/plans/:id/rejected-findings", async (c) => {
  const planId = c.req.param("id");
  const [plan] = await sql`SELECT 1 FROM plans WHERE plan_id = ${planId}`;
  if (!plan) return c.json({ error: "plan not found" }, 404);
  const findings = await sql`
    SELECT f.id, f.verification_run_id, f.finding, f.out_of_change, f.locations, f.subject, f.state,
           f.raised_at, f.adjudicated_at, f.adjudication_note
    FROM verification_findings f
    JOIN verification_runs v ON v.id = f.verification_run_id
    JOIN plan_revisions r ON r.id = v.plan_revision_id
    WHERE r.plan_id = ${planId} AND f.state = 'rejected'
    ORDER BY f.raised_at, f.id
  `;
  return c.json(findings);
});

app.get("/plan-revisions/:id/findings", async (c) => {
  const revisionId = c.req.param("id");
  const [revision] = await sql`SELECT 1 FROM plan_revisions WHERE id::text = ${revisionId}`;
  if (!revision) return c.json({ error: "plan revision not found" }, 404);
  const findings = await sql`
    SELECT f.id, f.verification_run_id, v.layer, v.attempt, f.finding,
           f.out_of_change, f.locations, f.subject, f.state, f.raised_at, f.adjudicated_at,
           f.adjudication_note
    FROM verification_findings f
    JOIN verification_runs v ON v.id = f.verification_run_id
    WHERE v.plan_revision_id = ${revisionId}
    ORDER BY f.raised_at, f.id
  `;
  return c.json(findings);
});

app.post("/plan-revisions/:id/approvals", async (c) => {
  const revisionId = c.req.param("id");
  const [revision] = await sql`SELECT id FROM plan_revisions WHERE id::text = ${revisionId}`;
  if (!revision) return c.json({ error: "plan revision not found" }, 404);
  const [existing] = await sql`
    SELECT id FROM approvals
    WHERE subject_kind = 'plan_revision'
      AND plan_revision_id = ${revision.id}
      AND resolved_at IS NULL
  `;
  if (existing) return c.json(existing);
  const [approval] = await sql`
    INSERT INTO approvals (subject_kind, plan_revision_id, lane_id)
    VALUES ('plan_revision', ${revision.id}, NULL)
    RETURNING id
  `;
  return c.json(approval, 201);
});

app.post("/lanes", async (c) => {
  const body = await c.req.json();

  const invalidField = invalidLaneField(body);
  if (invalidField) {
    return c.json({ error: `invalid ${invalidField}`, field: invalidField }, 400);
  }

  if (body.plan_revision_id !== undefined) {
    const [revision] = await sql`SELECT 1 FROM plan_revisions WHERE id::text = ${body.plan_revision_id}`;
    if (!revision) return c.json({ error: "invalid plan_revision_id", field: "plan_revision_id" }, 400);
  }

  const nonterminal = await sql`
    SELECT lane_id, owned_paths FROM lanes
    WHERE status NOT IN ('completed', 'failed')
  `;
  for (const row of nonterminal) {
    if (pathsOverlap(body.owned_paths, row.owned_paths)) {
      return c.json(
        { error: "owned_paths conflict", conflicting_lane_id: row.lane_id },
        409,
      );
    }
  }

  const lane: Lane = {
    lane_id: body.lane_id,
    owned_paths: body.owned_paths,
    lane_type: body.lane_type,
    model: body.model ?? "balanced",
    depends_on: body.depends_on ?? [],
    status: "pending",
    worktree_path: body.worktree_path,
    attempt_count: 0,
    original_brief: body.original_brief,
    plan_revision_id: body.plan_revision_id ?? null,
  };

  await sql`
    INSERT INTO lanes
      (lane_id, owned_paths, lane_type, model, depends_on, status, worktree_path, attempt_count, original_brief, plan_revision_id)
    VALUES (
      ${lane.lane_id},
      ${sql.array(lane.owned_paths, "text")},
      ${lane.lane_type},
      ${lane.model},
      ${sql.array(lane.depends_on, "text")},
      ${lane.status},
      ${lane.worktree_path},
      ${lane.attempt_count},
      ${lane.original_brief},
      ${lane.plan_revision_id}
    )
  `;
  return c.json({ lane_id: lane.lane_id, status: lane.status }, 201);
});

app.delete("/lanes/:id", async (c) => {
  const laneId = c.req.param("id");
  const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`;
  if (!lane) return c.json({ error: "lane not found" }, 404);
  if (lane.status === "running") return c.json({ error: "cannot delete a running lane" }, 409);
  await sql`DELETE FROM messages WHERE lane_id = ${laneId}`;
  await sql`DELETE FROM approvals WHERE lane_id = ${laneId}`;
  await sql`DELETE FROM lanes WHERE lane_id = ${laneId}`;
  return c.json({ lane_id: laneId, deleted: true });
});

app.get("/lanes/:id/gate", async (c) => c.json(await checkGate(c.req.param("id"))));

app.get("/lanes", async (c) => {
  const lanes = await sql`
    SELECT l.lane_id, l.status, l.worktree_path, l.plan_revision_id,
           p.plan_id, p.revision, p.approved_at
    FROM lanes l
    LEFT JOIN plan_revisions p ON p.id = l.plan_revision_id
    ORDER BY l.lane_id
  `;
  return c.json(lanes);
});

app.get("/lanes/:id/evidence", async (c) => {
  const laneId = c.req.param("id");
  const [lane] = await sql`SELECT lane_id FROM lanes WHERE lane_id = ${laneId}`;
  if (!lane) return c.json({ error: "lane not found" }, 404);

  const evidence = await sql`
    SELECT id, created_at, evidence_refs FROM messages
    WHERE lane_id = ${laneId} AND message_type = 'EVIDENCE'
    ORDER BY created_at DESC, id DESC
  `;
  return c.json({ lane_id: laneId, evidence });
});

app.post("/lanes/:id/start", async (c) => {
  const laneId = c.req.param("id");
  const [lane] = await sql`SELECT status FROM lanes WHERE lane_id = ${laneId}`;

  if (!lane) {
    return c.json({ error: "lane not found" }, 404);
  }
  // A resumed lane is still 'waiting_approval' when the dispatcher picks it back
  // up, and it must reach 'running' like any other: the gate counts running
  // lanes for MAX_ACTIVE_LANES and for owned_paths conflicts, so a lane that
  // executes without that transition is invisible to both checks. checkGate
  // below rejects the case where the approval is still unresolved.
  if (lane.status !== "pending" && lane.status !== "waiting_approval") {
    return c.json({ error: `cannot start lane with status '${lane.status}'` }, 409);
  }

  const gate = await checkGate(laneId);
  if (!gate.allowed) {
    return c.json({ error: "gate closed", reason: gate.reason }, 409);
  }

  const [started] = await sql`
    UPDATE lanes SET status = 'running'
    WHERE lane_id = ${laneId}
    RETURNING lane_id, status
  `;
  return c.json(started);
});

app.post("/lanes/:id/messages", async (c) => {
  const laneId = c.req.param("id");
  const body = await c.req.json();

  const [message] = await sql`
    INSERT INTO messages (lane_id, message_type, question, answer, evidence_refs)
    VALUES (
      ${laneId},
      ${body.message_type},
      ${body.question ?? null},
      ${body.answer ?? null},
      ${body.evidence_refs ?? null}
    )
    RETURNING id
  `;

  if (body.message_type === "APPROVAL_REQUEST") {
    const [existing] = await sql`
      SELECT id FROM approvals
      WHERE subject_kind = 'lane' AND lane_id = ${laneId} AND resolved_at IS NULL
    `;
    if (!existing) {
      await sql`
        INSERT INTO approvals (subject_kind, lane_id, plan_revision_id)
        VALUES ('lane', ${laneId}, NULL)
      `;
    }
    await sql`UPDATE lanes SET status = 'waiting_approval' WHERE lane_id = ${laneId}`;
  }

  return c.json({ id: message.id }, 201);
});

app.post("/lanes/:id/result", async (c) => {
  const laneId = c.req.param("id");
  const body = await c.req.json();

  const [current] = await sql`
    SELECT status, attempt_count,
      EXISTS (
        SELECT 1 FROM approvals
        WHERE lane_id = ${laneId} AND resolved_at IS NULL
      ) AS has_unresolved_approval
    FROM lanes
    WHERE lane_id = ${laneId}
  `;
  if (!current) {
    return c.json({ error: "lane not found" }, 404);
  }
  // A lane that stopped to ask a question produced no work verdict, so its
  // exit code must not be read as one.
  if (current.has_unresolved_approval) {
    return c.json({ status: current.status, attempt_count: current.attempt_count });
  }

  let lane;

  if (body.exit_code === 0) {
    if (typeof body.evidence_passed !== "boolean") {
      return c.json({ error: "evidence_passed must be boolean for exit_code 0" }, 400);
    }
    const status = body.evidence_passed ? "completed" : "failed";
    [lane] = await sql`
      UPDATE lanes SET status = ${status}
      WHERE lane_id = ${laneId}
      RETURNING status, attempt_count
    `;
  } else if (body.exit_code === 30) {
    [lane] = await sql`
      UPDATE lanes SET status = 'failed'
      WHERE lane_id = ${laneId}
      RETURNING status, attempt_count
    `;
  } else if (body.exit_code === 20) {
    [lane] = await sql`
      UPDATE lanes
      SET attempt_count = attempt_count + 1,
          status = CASE WHEN attempt_count + 1 >= 3 THEN 'failed' ELSE 'pending' END
      WHERE lane_id = ${laneId}
      RETURNING status, attempt_count
    `;
  } else {
    return c.json(
      { error: "unsupported exit_code for /result (use /messages for exit_code 10)" },
      400,
    );
  }

  // An UPDATE that matched nothing must not read as a recorded result: a
  // dispatcher typo in lane_id would otherwise look like a successful post.
  if (!lane) {
    return c.json({ error: "lane not found" }, 404);
  }
  return c.json(lane);
});

app.get("/pending", async (c) => {
  // Keep the construction-failure sentence below in sync with planSnapshot in dashboard-data.ts.
  const waitingApproval = await sql`
    SELECT 'lane'::text AS subject_kind, l.lane_id,
           NULL::uuid AS plan_revision_id, NULL::text AS plan_id,
           NULL::int AS revision, l.status, m.question
    FROM lanes l
    JOIN approvals a ON a.subject_kind = 'lane'
      AND a.lane_id = l.lane_id AND a.resolved_at IS NULL
    JOIN LATERAL (
      SELECT question FROM messages
      WHERE lane_id = l.lane_id AND message_type = 'APPROVAL_REQUEST'
      ORDER BY created_at DESC LIMIT 1
    ) m ON true
    WHERE l.status = 'waiting_approval'
    UNION ALL
    SELECT 'plan_revision', NULL, r.id, p.plan_id, r.revision,
           'waiting_approval',
           COALESCE(
             'Candidate construction failed during ' || (v.detail->>'step') || ': ' || (v.detail->>'message'),
             'Candidate construction failed and needs attention.'
           )
    FROM approvals a
    JOIN plan_revisions r ON r.id = a.plan_revision_id
    JOIN plans p ON p.plan_id = r.plan_id
    LEFT JOIN LATERAL (
      SELECT detail FROM verification_runs
      WHERE plan_revision_id = r.id AND layer = 'construction' AND status = 'failed'
      ORDER BY attempt DESC LIMIT 1
    ) v ON true
    WHERE a.subject_kind = 'plan_revision' AND a.resolved_at IS NULL
  `;
  const failed = await sql`
    SELECT lane_id, status FROM lanes WHERE status = 'failed'
  `;
  const findings = await sql`
    SELECT p.plan_id, p.title, r.id AS plan_revision_id, r.revision,
           f.finding, f.subject, f.locations
    FROM verification_findings f
    JOIN verification_runs v ON v.id = f.verification_run_id
    JOIN plan_revisions r ON r.id = v.plan_revision_id
    JOIN plans p ON p.plan_id = r.plan_id
    WHERE f.state = 'open'
    ORDER BY f.raised_at DESC, f.id DESC
  `;
  return c.json({ waiting_approval: waitingApproval, failed, findings });
});

app.post("/approvals/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (!actor(body?.resolved_by)) return c.json({ error: "invalid resolved_by", field: "resolved_by" }, 400);
  if (body.verified_by !== undefined && !actor(body.verified_by)) {
    return c.json({ error: "invalid verified_by", field: "verified_by" }, 400);
  }
  const [approval] = await sql`SELECT resolved_at FROM approvals WHERE id = ${id}`;

  if (!approval) {
    return c.json({ error: "approval not found" }, 404);
  }
  if (approval.resolved_at) {
    return c.json({ error: "approval already resolved" }, 409);
  }

  const [updated] = await sql`
    UPDATE approvals
    SET resolved_at = now(), resolved_by = ${body.resolved_by}, verified_by = ${body.verified_by ?? null}, decision = ${body.decision}
    WHERE id = ${id}
    RETURNING id, resolved_at
  `;
  return c.json(updated);
});

// Everything CONDUCTOR may act on in one query: never-started lanes, plus
// lanes whose approval has come back. A lane with any unresolved approval is
// still waiting on a human and must not be redispatched.
app.get("/lanes/dispatchable", async (c) => {
  const lanes = await sql`
    SELECT lane_id, owned_paths, lane_type, model, depends_on, worktree_path,
           original_brief, NULL::text AS resume_decision
    FROM lanes
    WHERE status = 'pending'
    UNION ALL
    SELECT l.lane_id, l.owned_paths, l.lane_type, l.model, l.depends_on, l.worktree_path,
           l.original_brief, a.decision AS resume_decision
    FROM lanes l
    JOIN LATERAL (
      SELECT decision FROM approvals
      WHERE lane_id = l.lane_id AND resolved_at IS NOT NULL
      ORDER BY resolved_at DESC LIMIT 1
    ) a ON true
    WHERE l.status = 'waiting_approval'
      AND NOT EXISTS (
        SELECT 1 FROM approvals
        WHERE lane_id = l.lane_id AND resolved_at IS NULL
      )
  `;
  return c.json(lanes);
});

// Mounted last so the JSON API above keeps priority over any path it shares.
app.route("/", createDashboard());

export default app;
