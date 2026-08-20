CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS lanes (
  lane_id        text PRIMARY KEY,
  owned_paths    text[] NOT NULL,
  lane_type      text NOT NULL CHECK (lane_type IN ('write', 'read_review')),
  model          text NOT NULL DEFAULT 'balanced' CHECK (model IN ('fast', 'balanced', 'deep')),
  depends_on     text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed')),
  worktree_path  text NOT NULL,
  attempt_count  int NOT NULL DEFAULT 0,
  original_brief text NOT NULL
);

-- Added after the table existed, so CREATE TABLE IF NOT EXISTS above is a no-op
-- on a database created before the model tier field.
ALTER TABLE lanes
  ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'terra'
    CHECK (model IN ('sol', 'terra', 'luna'));

-- The tier names moved from Codex-specific (sol/terra/luna) to agent-neutral
-- (fast/balanced/deep), so the core no longer names one agent's models in a
-- database constraint. This migrates existing rows, then swaps the default and
-- the constraint to match. Idempotent: on an already-migrated database the
-- UPDATEs touch no rows (nothing is still 'sol'/'terra'/'luna'), and DROP
-- CONSTRAINT IF EXISTS makes the constraint swap safe to run again too.
UPDATE lanes SET model = 'deep' WHERE model = 'sol';

UPDATE lanes SET model = 'balanced' WHERE model = 'terra';

UPDATE lanes SET model = 'fast' WHERE model = 'luna';

ALTER TABLE lanes
  ALTER COLUMN model SET DEFAULT 'balanced';

ALTER TABLE lanes
  DROP CONSTRAINT IF EXISTS lanes_model_check;

ALTER TABLE lanes
  ADD CONSTRAINT lanes_model_check
    CHECK (model IN ('fast', 'balanced', 'deep'));

CREATE TABLE IF NOT EXISTS messages (
  id            serial PRIMARY KEY,
  lane_id       text NOT NULL REFERENCES lanes(lane_id),
  message_type  text NOT NULL
                  CHECK (message_type IN ('QUESTION', 'CLAIM', 'EVIDENCE', 'APPROVAL_REQUEST', 'FAILURE', 'COMPLETED')),
  question      text,
  answer        text,
  evidence_refs jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_id       text NOT NULL REFERENCES lanes(lane_id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   text CHECK (resolved_by IN ('human', 'claude')),
  decision      text
);

CREATE TABLE IF NOT EXISTS plans (
  plan_id    text PRIMARY KEY,
  title      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ponytail: immutable content is guarded by routes, add a database trigger when db/migrate.ts can carry a plpgsql body.
CREATE TABLE IF NOT EXISTS plan_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     text NOT NULL REFERENCES plans(plan_id),
  revision    int NOT NULL,
  content     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by text CHECK (approved_by IN ('human', 'claude')),
  UNIQUE (plan_id, revision)
);

ALTER TABLE lanes
  ADD COLUMN IF NOT EXISTS plan_revision_id uuid REFERENCES plan_revisions(id);

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS verified_by text CHECK (verified_by IN ('human', 'claude'));

-- Routes enforce exactly the reference named by subject_kind: PostgreSQL has no
-- ADD CONSTRAINT IF NOT EXISTS, and db/migrate.ts cannot carry a DO block.
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL DEFAULT 'lane'
    CHECK (subject_kind IN ('lane', 'plan_revision'));

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS plan_revision_id uuid REFERENCES plan_revisions(id);

ALTER TABLE approvals
  ALTER COLUMN lane_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS verification_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id uuid NOT NULL REFERENCES plan_revisions(id),
  layer            text NOT NULL CHECK (layer IN ('construction', 'clean_run', 'reader')),
  attempt          int NOT NULL,
  status           text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  detail           jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (plan_revision_id, layer, attempt)
);

-- `no_findings` is D-027's, and it is not a synonym for `succeeded`: the reader
-- samples, so a run that surfaced nothing is a sampling that happened to be
-- empty and never a passed check. Recorded as `succeeded` it would read as one.
-- Added after the table existed, so the CHECK above is what a database created
-- before this decision still carries. The two statements below replace it and
-- are safe to run again. Keep semicolons out of comments in this file, in prose
-- and in backticks alike: db/migrate.ts splits the whole file on that character,
-- so one inside a comment cuts the statement after it in half.
ALTER TABLE verification_runs
  DROP CONSTRAINT IF EXISTS verification_runs_status_check;

ALTER TABLE verification_runs
  ADD CONSTRAINT verification_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'no_findings')
           AND (status <> 'no_findings' OR layer = 'reader'));

CREATE TABLE IF NOT EXISTS verification_findings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_run_id uuid NOT NULL REFERENCES verification_runs(id),
  finding             text NOT NULL,
  out_of_change       boolean NOT NULL DEFAULT false,
  locations           jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject             text NOT NULL CHECK (subject IN ('test_diff', 'source_context')),
  state               text NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'accepted', 'rejected', 'deferred')),
  raised_at           timestamptz NOT NULL DEFAULT now(),
  adjudicated_at      timestamptz,
  adjudication_note   text
);

ALTER TABLE verification_findings
  ADD COLUMN IF NOT EXISTS locations jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE verification_findings
  ADD COLUMN IF NOT EXISTS subject text DEFAULT 'test_diff';

ALTER TABLE verification_findings
  ALTER COLUMN subject SET NOT NULL;

ALTER TABLE verification_findings
  ALTER COLUMN subject DROP DEFAULT;

ALTER TABLE verification_findings
  DROP CONSTRAINT IF EXISTS verification_findings_subject_check;

ALTER TABLE verification_findings
  ADD CONSTRAINT verification_findings_subject_check
    CHECK (subject IN ('test_diff', 'source_context'));

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('lane', 'plan', 'plan_revision')),
  subject_id  text NOT NULL,
  event_class text NOT NULL CHECK (event_class IN ('approval_required', 'lane_failed', 'plan_ready_for_review', 'findings_to_adjudicate')),
  occurrence  int NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  UNIQUE (subject_kind, subject_id, event_class, occurrence)
);

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_subject_kind_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_subject_kind_check
    CHECK (subject_kind IN ('lane', 'plan', 'plan_revision'));

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_event_class_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_event_class_check
    CHECK (event_class IN ('approval_required', 'lane_failed', 'plan_ready_for_review', 'findings_to_adjudicate'));

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
