# Phase 4 pilot: neura-system

Date: 2026-08-08. Driven repository: `neura-system`, a Bun/TypeScript scaffold
with a real Phase 1 of its own to deliver. Lane: the Apache AGE + pgvector
database image, a migration runner, the first migration, unit tests, and the
repository's `.laneward/project.json`.

This is the first lane on this project driven by a real Codex worker that
reached a recorded verdict. Everything before it either used the fake-codex
fixture or ended with an empty evidence array.

## What the loop actually did

The worker delivered every owned file and escalated honestly rather than
claiming a build it could not run: the sandbox denies `Bun.spawn`, so it could
not build a container. The host verification it asked for found three real
defects in its own Dockerfile, all of them things a sandbox with no network
could not have checked:

1. `--branch "PG17/v1.6.0"` does not exist upstream. The refs Apache AGE
   publishes for PG17 are the branches `release/PG17/1.6.0` and
   `release/PG17/1.7.0` and the tags `PG17/v1.6.0-rc0` and `PG17/v1.7.0-rc0`.
2. The AGE build needs `perl`, which `postgres:17.10-alpine3.23` does not ship.
   It stops at `make: /usr/bin/perl: No such file or directory`.
3. Both extensions try to emit LLVM bitcode and the base image has no clang:
   `make: clang-21: No such file or directory`. `with_llvm=no` on both `make`
   invocations is the fix, at the cost of JIT bitcode for the extensions.

Those three findings went back through `POST /approvals/:id` as the lane's
resume decision. The worker applied all three, corrected `database/README.md`
to claim only what was verified and on which platform, and the conductor
recorded `overall: "passed"` for both declared checks: `bun run typecheck` and
`bun test`, 3 tests. `GET /lanes/:id/evidence` returns that verdict from
Postgres with no conductor in memory.

## Runtime verification of the delivered result

Performed on the worker's own files, not on the probe used to find the defects.
`podman build -f database/Dockerfile database` succeeds. A container started
from that image on a fresh named volume, with no extension created by hand,
answers `bun run db:migrate` by creating both extensions and recording
`0001_extensions.sql` in `schema_migrations`; `pg_extension` then reports
`age 1.6.0` and `vector 0.8.2`. A second `db:migrate` applies nothing and exits
0. `create_graph` plus a cypher `CREATE` returns a vertex and
`'[1,2,3]'::vector <-> '[1,2,4]'::vector` returns 1, so both extensions work
rather than merely installing.

Not verified: anything on Linux or with Docker, and the ADR 0005 host-detection
path, which is not implemented yet. The container was published on 5434 because
5433 on this host belongs to Laneward's own database.

## Three defects this pilot found in Laneward

**An escalating worker got no evidence at all.** `runLane` matched the
escalation marker before it ran the lane checks, so a worker that escalates,
which on this host is every honest worker that needs a container, produced an
`APPROVAL_REQUEST` and nothing else. The checks now run whenever the worker
left owned changes; the worker's own question still wins the approval request.

**The lane opener's own lockfile failed the worker.** `scripts/new-lane.ts`
runs `bun install`, which writes `bun.lock` into a repository that has never
committed one. The evidence check scores every dirty path against
`owned_paths`, so the first run was failed for a file the worker never touched,
before its work was looked at. Paths that appear during the opener's install
are now registered with the lane.

**A lane could be registered against a worktree that does not exist.** A
hand-built registration mangled the Windows path separators; `POST /lanes`
accepted it, and the problem only surfaced three Codex dispatches later, as a
lane that failed on `The system cannot find the file specified` and looked like
its own work was at fault. Registration now checks the path.

## Where the manual process hurt

- **Per-lane database isolation only works for a single `DATABASE_URL`.**
  `provisionLaneDatabase` matches `^DATABASE_URL=` in the copied `.env`.
  `neura-system` keeps `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME` and
  `DATABASE_USER` separately, so no lane database was created and no isolation
  existed. Harmless for this lane, which needed no database, and a real gap
  before the schema lane that follows.
- **The hub's own suite is still a live-data hazard.** Running `bun test` from
  the laneward checkout with the hub's `.env` loaded truncated `lanes`,
  `messages` and `approvals` mid-pilot and deleted the live lane row, its
  escalation and its approval. The lane-checks fix protects the conductor's
  child process, not a suite run by hand. Use
  `DATABASE_URL=...:5433/laneward_test` for hand runs.
- **There is no way to correct a lane record.** After the truncation the lane
  had to be re-registered under a new id, `neura-phase1-migrations-2`, because
  the API has no update or delete route and the original id was still held by
  the failed row.
- **`resolved_by` records who typed the decision, not who verified it.** The
  host verification here was done by Claude and resolved as `claude`; nothing
  in the record distinguishes a decision the user approved from one Claude
  reached on its own. Phase 5's approval records should carry that difference.
- **`POST /approvals/:id` still answers 500 for a `resolved_by` outside the
  schema's check constraint.** Unchanged from before the pilot, and still worth
  a 400.

## Lane 2: the NeuraCore schema and the audit trail

The second lane delivered `neuracore.sources` seeded with the eight sources
spec section 32 names, `neuracore.entities` constrained to the types section 5.2
defines, `neuracore.memories` with every field section 31 requires and its
status and confidence constrained, `neuracore.memory_versions` per section 30,
and the `audit` schema's `actions`, `memory_changes` and `approvals` with no
cascade from an audited table. It took three dispatches, and this was the first
lane whose worker had a database of its own to test against, which the split-key
provisioning fix made possible.

Two more defects, both invisible without running the suite:

- **`await expect(<postgres query>).rejects.toThrow()` never settles.** A
  `postgres` tagged template returns the library's own lazy query object;
  driving it through `expect().rejects` leaves it never executed and never
  rejected. Five of the six tests used that shape, so `bun test` hung and burned
  the checker's entire 600 second timeout, recorded as `overall: "unrunnable"`.
  The same statement in a `try`/`catch` rejects in about 18 ms. That is one
  hung check costing ten minutes of wall clock, which is the cost of the
  timeout default rather than a defect in it.
- **A `jsonb` value written as a stringified string round trips as a string.**
  `${JSON.stringify(value)}::jsonb` stores a jsonb string scalar, not an
  object. `sql.json(value)` is the fix; the column type was already right.

Both went back as approval decisions and the worker applied them. Third
dispatch: `overall: "passed"`, both checks green. Verified independently
afterwards: 9 of 9 tests pass, the migrations apply to a fresh database and are
a no-op on a second run, and `neuracore` holds 4 tables and `audit` 3.

Merged into `main` as `1d4bee2`, worktree and branch removed, and the merged
`main` re-verified against the shared `neura` database: `db:migrate` applies all
three migrations and the suite passes 9 of 9 there too. The lane's own database
was dropped by hand, because nothing drops it when a lane finishes.

## Not done

Nothing is pushed; both merges are local by decision. The two lanes ran one
after another rather than concurrently, so lane-level concurrency is still
unexercised on real work. `resolved_by` still records who typed a decision
rather than who verified it, `POST /approvals/:id` still answers 500 for a
`resolved_by` outside the check constraint, a finished lane's database is still
not dropped, and the hub still has no way to correct or remove a lane record.
