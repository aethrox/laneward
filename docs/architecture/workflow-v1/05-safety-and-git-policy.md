# Safety and Git policy

## Agent Git boundary

The statement "an agent must not use Git" must be technically enforced, not merely written in a prompt.

An agent may use read-only inspection when necessary, such as:

- current diff;
- file history needed for diagnosis;
- branch name;
- untracked-file inspection.

An agent must be blocked from:

- `git add`;
- `git commit`;
- `git push`;
- `git merge`;
- `git rebase`;
- `git reset`;
- `git checkout` or `git switch` when they mutate worktree state;
- `git worktree`;
- `git tag`;
- branch creation or deletion;
- ref updates.

Enforcement options should be layered:

1. the lane brief states the rule;
2. the agent's execution environment denies mutation commands;
3. repository credentials are unavailable to workers;
4. Laneward validates resulting Git state;
5. Claude owns the commit step.

A prompt-only rule is insufficient.

Layer 2 means the worker's own environment, not an agent's own sandbox. Per D-023 the boundary must never rest on sandbox denial. Sandbox behavior may reinforce it, but it is not the control.

Layers 2, 3, and 4 are now implemented, on Windows, as of the Phase 2 work landed 2026-08-07 on `lane/phase2-git-boundary`. Layer 2 is `scripts/git-guard.ts`, a deny-by-default guard on the worker's PATH (via `scripts/git-shim/`) that allows only an explicit list of read-only subcommands and refuses everything else, including unknown subcommands and global options that could smuggle execution in before the subcommand. A refusal exits 86 and is logged as JSON. Layer 3 is `buildWorkerEnv` in `src/conductor.ts`, which drops credential-bearing variables from the worker environment, points `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at the platform null device, sets `GIT_TERMINAL_PROMPT=0`, and gives `gh` an empty config directory. Layer 4 is split across two files: `runLane` in `src/conductor.ts` snapshots HEAD and the checked-out ref before dispatch, and `scripts/check-evidence.ts` compares that snapshot after the worker exits, exiting 3 on a moved HEAD, a changed ref, a populated index, or a non-empty guard log. What this does not cover: the repository-local git config, including the remote URL, is still readable from inside a lane worktree, unchanged by this work. On Linux all three layers are covered by tests that pass, measured 2026-08-15 by running the suite under WSL ([notes](../../notes/2026-08-15-linux-suite-run.md)); no lane has been driven end to end there, so Linux is evidenced by tests rather than by operation. See the Phase 2 status note in [09-implementation-roadmap.md](09-implementation-roadmap.md) for the measured evidence.

Three facts shaped this work and are recorded here as history, though the first two no longer describe the current state:

- The sandbox already denies the mutations, on Windows. Measured 2026-08-07: a lane worktree's object store sits outside the writable workspace, Git cannot write its lock file, and every mutating command fails while read commands succeed. The sandbox's own behaviour on Linux is still unmeasured; only the guard's tests are. See [../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md](../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md).
- At the time this section was written, nothing Laneward owned enforced the boundary; the denial above belonged to the sandbox alone, and the same measurement session included hours in which that sandbox did not function at all and then hours running with it disabled entirely. Layer 2 was built to survive that, and now does: the guard and shim are Laneward's own control, independent of sandbox behavior, measured on Windows on 2026-08-07.
- A violation used to misreport: a lane that committed left a clean worktree, so the evidence check reported "write lane produced no changes" and the lane moved to `waiting_approval` with a misleading reason. This is fixed. `scripts/check-evidence.ts` now checks Git state first and exits 3, with its own distinct reason, before it ever reaches the no-changes branch.

## Path ownership

A write lane may change only its approved owned paths.

Laneward rejects a lane whose owned paths overlap any lane that is not `completed` or `failed`, with a `409` naming the conflict. A plan that serializes the lanes is not an exception; see D-036 for why that permission was withdrawn.

Generated files, lockfiles, migrations, shared schemas, and formatting changes must be declared rather than treated as harmless incidental edits.

## Network policy

Agent network access is denied by default.

An exception requires:

- a stated purpose;
- named lane;
- expected destination or resource class;
- user approval in the active plan revision;
- an expiry at lane completion.

A network exception must not become a global default.

## Secret handling

Workers may use already-configured commands that consume secrets without revealing them, but they must not:

- print secret values;
- copy secrets into briefs;
- store secrets in Laneward;
- include secrets in Git;
- expose secrets in reports or logs;
- repurpose unrelated credentials.

Logs should apply redaction before persistence.

## Approval classes

### Plan approval

Authorizes the documented code scope, local checks, and declared lane graph.

### Scope-change approval

Required when the authorized plan changes materially.

### Runtime approval

Required immediately before installation, migration, restart, writes to real systems, or other external effects.

### Merge and push approval

Required before integration reaches the target branch or remote.

### Verification correction approval

Required before any verification-layer finding becomes a correction lane. The reader's findings advise only, per D-027, so they never reach a correction lane without this approval.

These are separate decisions and must not be collapsed into a broad "approved" flag.

## Commit gate

Claude may commit a lane only when:

- the worker is no longer running;
- the diff is available;
- owned-path validation passes;
- required lane tests pass;
- the brief is satisfied;
- no unresolved approval remains;
- no secret or prohibited artifact is present.

The commit message should describe one coherent result. A lane may require more than one commit only when the approved plan explicitly justifies it.

## Integration gate

Before requesting merge, push, or runtime approval:

- all required lane commits are integrated;
- integration tests pass;
- migrations and generated artifacts are consistent;
- project documentation is updated when needed;
- rollback is defined for consequential runtime changes;
- the verification layer has run and its record exists, once it is built. It stops nothing in shadow mode, per D-028.

## Destructive actions

Destructive targets must be resolved explicitly. Broad or inferred paths are prohibited.

A plan that cannot describe recovery or rollback for a consequential change is not ready for approval.
