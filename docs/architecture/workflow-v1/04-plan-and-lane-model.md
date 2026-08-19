# Plan and Lane Model

This document describes the target concepts. It is not yet a database migration specification.

The statuses proposed here are candidates. Per the roadmap, plan records are built after the pilot, and a status is added only when a concrete operator action sits behind it.

## Plan

A plan is the parent record for one approved unit of work.

Suggested fields:

| Field | Meaning |
|---|---|
| `id` | Stable plan identifier |
| `project_id` | Project registration |
| `title` | Short human-readable name |
| `objective` | Expected outcome |
| `revision` | Monotonic approval revision |
| `status` | Current lifecycle state |
| `risk_level` | Low, medium, high, or critical |
| `base_ref` | Starting Git ref |
| `integration_branch` | Plan integration branch |
| `concurrency_limit` | Approved maximum |
| `network_policy` | Default deny plus lane exceptions |
| `runtime_effects` | Installation and external side effects |
| `runtime_verification` | Definition of real success |
| `approved_at` | Approval timestamp |
| `approved_revision` | Exact approved revision |
| `created_by_session` | Claude session identity |

## Plan status

Recommended initial statuses:

- `draft`
- `awaiting_approval`
- `approved`
- `executing`
- `awaiting_integration`
- `validating`
- `release_candidate`
- `awaiting_runtime_approval`
- `deploying`
- `done`
- `blocked`
- `cancelled`

## Plan revision rules

A new revision is mandatory when any of these change:

- objective or expected behavior;
- files or systems that may be modified;
- lane dependency graph;
- network access;
- destructive or external effects;
- deployment target;
- risk level;
- runtime verification contract.

The old approval remains historically visible but does not authorize the new revision.

## Lane

A lane is a bounded execution unit inside one plan revision.

Suggested fields:

| Field | Meaning |
|---|---|
| `id` | Stable lane identifier |
| `plan_id` | Parent plan |
| `plan_revision` | Revision that authorized it |
| `type` | Read, write, verification, integration, or deployment |
| `brief` | Immutable approved brief plus appended decisions |
| `owned_paths` | Exclusive write scope |
| `depends_on` | Lane dependencies |
| `worktree_path` | Laneward-owned worktree |
| `branch_name` | Lane branch |
| `worker_type` | Codex or deterministic command |
| `network_policy` | Lane-specific network decision |
| `checks` | Required lane gates |
| `status` | Operational state |
| `evidence` | Logs, test results, and diff verdict |
| `commit_sha` | Claude-created commit after review |

## Lane status

The existing states should be extended carefully rather than replaced without migration analysis.

Target semantics include:

- `pending`: registered but not yet eligible;
- `blocked`: dependency or ownership conflict;
- `running`: worker executing;
- `waiting_approval`: a human decision is required;
- `ready_for_review`: Codex finished; Claude review is required;
- `changes_requested`: review failed within approved scope;
- `verified`: Claude checks passed;
- `committed`: Claude created the lane commit;
- `failed`: execution failed and cannot retry automatically;
- `cancelled`: intentionally stopped.

`ready_for_review` is essential because worker completion and validated completion are different facts.

## Project manifest

Each managed project should provide `.laneward/project.json`. The file is JSON,
not YAML: the runtime reads it with `readProjectManifest` in
`src/lane-checks.ts`, and this repository has no YAML parser.

Conceptual example:

```json
{
  "version": 1,
  "project": { "id": "example-service", "type": "linux-service" },

  "checks": {
    "lane": [{ "name": "tests", "command": ["bun", "test"] }],
    "integration": [
      { "name": "tests", "command": ["bun", "test"] },
      { "name": "lint", "command": ["bun", "run", "lint"] }
    ],
    "runtime": [
      { "name": "active", "command": ["systemctl", "--user", "is-active", "example.service"] }
    ]
  },

  "privacy": { "codex_network": "deny", "redact_logs": true },

  "deployment": {
    "requires_approval": true,
    "rollback_command": ["systemctl", "--user", "restart", "example.previous.service"]
  }
}
```

Current state (2026-08-15): only `version` and `checks.lane` are read. Each entry
under `checks.lane` needs a unique `name` and a `command` argument array —
argument arrays rather than strings, because paths on the Windows host contain
spaces. The rest of the tree above is a sketch and is not yet parsed.

## Concurrency selection

Concurrency depends on independence, not task count.

Claude must consider:

- overlapping paths;
- shared migrations or schemas;
- machine memory and CPU;
- build and test resource usage;
- serial architectural dependencies;
- runtime side effects.

The approved plan stores the selected limit. Laneward enforces it.
