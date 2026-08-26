# API reference

Twenty-four JSON routes over four areas, plus four the dashboard serves. Plans
and revisions carry execution authority, lanes carry work, approvals carry the
decisions a human has to make.

Everything is served on `127.0.0.1` with **no authentication**. Errors are
uniformly `{"error": "..."}`, and a field-level validation error adds
`{"field": "..."}`. There is no `/health` route: `GET /pending` is the cheapest
liveness check.

## Plans

### `POST /plans`

Body `{plan_id, title, content}`. `plan_id` must be a slug, `content` a JSON
object. Creates the plan and its revision 1.

- `201` `{plan_id, revision, revision_id}`
- `400` invalid `plan_id`, `title` or `content`
- `409` `plan already exists`

### `POST /plans/:id/revisions`

Body `{content}`. Appends a revision numbered one above the current maximum.
Creating it withdraws execution authority from every lane bound to an older one.

- `201` `{plan_id, revision, revision_id}`
- `400` invalid `content`, `404` `plan not found`

### `POST /plans/:id/revisions/:revision/approve`

Body `{approved_by}`, either `human` or `claude`.

- `200` `{plan_id, revision, revision_id}`
- `400` invalid `approved_by`
- `404` `plan not found` or `plan revision not found`
- `409` `plan revision already approved`

### `GET /plans/:id`

- `200` `{plan_id, title, created_at, revisions[]}`, newest revision first. Each
  revision carries `{id, revision, content, created_at, approved_at, approved_by}`.
- `404` `plan not found`

### `GET /candidates/due`

- `200` `[{plan_id, revision, revision_id}]`: the newest revision of every plan
  whose lanes are all `completed` and which has no construction run yet.

## Verification

### `POST /verification-runs`

Body `{plan_revision_id, layer}`, layer one of `construction`, `clean_run`,
`reader`. Opens a run with status `running` and the next attempt number for that
revision and layer.

- `201` `{id, attempt}`, `400` invalid field, `404` `plan revision not found`

### `GET /verification-runs/latest`

Query `plan_revision_id` and `layer`. Returns the highest attempt.

- `200` `{id, plan_revision_id, layer, attempt, status, detail, started_at, finished_at}`,
  or `null` when there is no run. A missing run is `200 null`, not `404`.

### `POST /verification-runs/:id/result`

Body `{status, detail?}`. `status` is `succeeded`, `failed`, `skipped` or
`no_findings`; `detail` is an object or null.

- `200` `{id, status, detail, finished_at}`
- `409` `only a reader run can report no findings`
- `409` `verification run already closed`

### `POST /verification-runs/:id/findings`

Body `{finding, subject, out_of_change?, locations?}`. `subject` is `test_diff`
or `source_context`; each location is `{path, side, start_line, end_line}` with
`side` either `base` or `head`.

- `201` the stored finding, `state` starting at `open`
- `409` `verification run is not a reader run`, or `verification run already closed`

### `POST /verification-findings/:id/adjudication`

Body `{state, note?}`, state one of `accepted`, `rejected`, `deferred`.

- `200` `{id, state, adjudicated_at, adjudication_note}`
- `409` `verification finding already adjudicated`

### `GET /plan-revisions/:id/findings`

- `200` every finding on the revision, any state, oldest first.

### `GET /plans/:id/rejected-findings`

- `200` the rejected ones only. This is what the next reader run is told not to
  raise again.

## Lanes

### `POST /lanes`

Body `{lane_id, lane_type, worktree_path, owned_paths, original_brief, model?,
depends_on?, plan_revision_id?}`.

Validated in order: `lane_id` a slug; `lane_type` `write` or `read_review`;
`worktree_path` non-empty **and existing on disk**; `owned_paths` a non-empty
array; `original_brief` non-empty; `model` one of `fast`, `balanced`, `deep`;
`depends_on` an array. Defaults: model `balanced`, no dependencies, attempt count
0.

- `201` `{lane_id, status}` with status `pending`
- `400` `{error: "invalid <field>", field: "<field>"}`
- `409` `{error: "owned_paths conflict", conflicting_lane_id: "<id>"}` against
  any lane that is not `completed` or `failed`

### `GET /lanes`

- `200` `[{lane_id, status, worktree_path, plan_revision_id, plan_id, revision, approved_at}]`,
  ordered by lane id.

### `DELETE /lanes/:id`

- `200` `{lane_id, deleted: true}`, `404` `lane not found`,
  `409` `cannot delete a running lane`

### `GET /lanes/:id/gate`

- `200` `{allowed, reason}`, always. A lane that does not exist answers
  `{allowed: false, reason: "lane not found"}` rather than 404. The
  refusal reasons are listed in [Troubleshooting](troubleshooting.md#lane-will-not-start).

### `GET /lanes/dispatchable`

- `200` the lanes the conductor may consider: `pending` ones, and
  `waiting_approval` ones whose approval has been resolved, the latter carrying
  `resume_decision`.

### `POST /lanes/:id/start`

Empty body. Re-checks the gate, then moves the lane to `running`.

- `200` `{lane_id, status}`
- `409` `cannot start lane with status '<status>'`, only `pending` and
  `waiting_approval` may start
- `409` `{error: "gate closed", reason: "<gate reason>"}`

### `POST /lanes/:id/messages`

Body `{message_type, question?, answer?, evidence_refs?}`. `message_type` is one
of `QUESTION`, `CLAIM`, `EVIDENCE`, `APPROVAL_REQUEST`, `FAILURE`, `COMPLETED`.
An `APPROVAL_REQUEST` also opens an approval and parks the lane in
`waiting_approval`, unless one is already open.

- `201` `{id}`

### `POST /lanes/:id/result`

Body `{exit_code, evidence_passed?}`. This is where a lane's fate is decided:

| `exit_code` | Effect |
|---|---|
| `0` | `evidence_passed` must be a boolean. True completes the lane, false fails it. |
| `20` | Retryable failure. Increments the attempt count, back to `pending`, `failed` on the third. |
| `30` | Policy or Git-boundary violation. `failed` at once, no retry. |
| anything else | `400`. Exit code 10 goes to `/messages`, not here. |

A lane with an unresolved approval ignores the result entirely and returns its
current state: a lane that stopped to ask a question produced no verdict, so its
exit code must not be read as one.

### `GET /lanes/:id/evidence`

- `200` `{lane_id, evidence: [{id, created_at, evidence_refs}]}`, newest first.

## Approvals

### `POST /plan-revisions/:id/approvals`

Opens an approval against a plan revision, idempotently: an unresolved one is
returned rather than duplicated (`200` instead of `201`).

### `POST /approvals/:id`

Body `{resolved_by, verified_by?, decision?}`. `resolved_by` and `verified_by`
are `human` or `claude`; `decision` is free text and is appended to the lane's
brief when it runs again.

- `200` `{id, resolved_at}`, `409` `approval already resolved`

## The operator's query

### `GET /pending`

- `200` `{waiting_approval, failed, findings}`. See
  [Daily operation](daily-operation.md#pending).

## The dashboard

| Route | Serves |
|---|---|
| `GET /` | The dashboard page |
| `GET /events` | Server-sent events: `lanes`, `plans`, `log` |
| `GET /lanes/:id/log` | A lane's whole log as plain text. `400` on an invalid id, `404` when there is no log yet |
| `GET /pico.css` | The vendored stylesheet |

The dashboard router is mounted last, so the JSON API above keeps priority over
any path it shares.
