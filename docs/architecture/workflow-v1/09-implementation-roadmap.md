# Implementation Roadmap

The roadmap is sequenced by risk and delivered value, not by architectural tidiness.

Two boundaries come first because they are the ones that can currently cause real damage or hide a false result. Bookkeeping structures come after a real pilot, so their shape is decided by observed need rather than by prediction.

Order revised on 2026-08-05. The previous order built plan and bridge infrastructure before the commit and integration flow.

Revised again on 2026-08-07. Phase 2 no longer opens with a probe, because D-023 makes its control mandatory either way, and Phase 2b was added for the cross-platform script rewrite that D-022 requires.

## Phase 1 — Reconcile the skills

Update the current skills so they describe one architecture.

Required outcomes:

- Codex commit permission is removed;
- all write work routes through Laneward;
- Obsidian references are replaced with project-local records;
- GPT Pro routing is disabled;
- OMP is absent;
- merge, push, and runtime approvals are consistent.

Acceptance evidence:

- conflicting rules search returns no unresolved contradiction;
- example workflows produce the same authority boundaries;
- skill routing cannot select disabled systems.

## Phase 2 — Enforce the Codex Git boundary

Implement technical controls, not just prompts.

The original plan opened with a probe: measure whether the `workspace-write` sandbox already denies a commit from a linked worktree, and build a control only if it does not. That sequencing is dropped. Per D-023 the control is required regardless of the answer, so the probe can no longer change what gets built.

The probe ran anyway on 2026-08-07, once a Codex sandbox failure on the Windows host was diagnosed and repaired, and it answered the original question: the `workspace-write` sandbox already denies every Git mutation from a lane worktree. Git cannot write its lock file into the parent repository's object store, which sits outside the writable workspace, so `add`, `commit`, `branch`, `tag`, `update-ref`, `worktree add`, and `config` all fail. Read commands still work. Full evidence and independent verification: [../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md](../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md).

That is a good result, and it does not shorten this phase. The confinement belongs to the sandbox, and the same day showed that sandbox being entirely absent on this host for hours. The wrapper becomes defense in depth rather than the only control, which is a change in its role, not in whether it is built.

Step order:

1. add a restricted `git` on the worker's `PATH` that permits read-only subcommands and rejects mutating ones, implemented identically for Windows and Linux;
2. keep repository credentials out of the worker environment — this is the gap the probe actually exposed, since the remote URL and credential helper were both readable from inside the lane;
3. make Laneward validate the resulting Git state after a worker exits, so a violation is caught even if both the wrapper and the sandbox are bypassed;
4. add a regression check that a prohibited command is rejected on both platforms.

Also fix the current misreport: a lane that commits leaves a clean worktree, and the evidence check then reports "write lane produced no changes". A Git-state violation must be reported as a violation, never as an empty result.

Acceptance evidence:

- Codex can edit approved files;
- Codex cannot commit, create branches, update refs, merge, push, or create worktrees;
- credentials are unavailable to the worker;
- a prohibited attempt appears in the evidence with its own distinct reason;
- all of the above are observed on Windows and on Linux.

The Windows half of that evidence is now producible: the sandbox failure that blocked it was fixed on 2026-08-07 by setting `[windows] sandbox = "unelevated"` in the Codex configuration. The Linux half was measured the same day in a Fedora 44 WSL distribution; see the status section below for what it did and did not cover.

### Status: Windows half done, 2026-08-07

Delivered on `lane/phase2-git-boundary`, four commits. `scripts/git-guard.ts` is a deny-by-default guard with an explicit allowlist of read-only subcommands (status, diff, log, show, rev-parse, ls-files, ls-tree, cat-file, blame, describe, grep, show-ref, for-each-ref, merge-base, diff-tree, diff-index, shortlog, name-rev, plus `branch` only as a pure listing); everything else, including unknown subcommands, is refused. Global options that can smuggle execution in before the subcommand (`-c`, `--config-env`, `--exec-path`, `--upload-pack`, `--receive-pack`, `--namespace`) are refused too. A refusal exits 86 and appends a JSON line to the file named by `LANEWARD_GIT_GUARD_LOG`. `scripts/git-shim/git.cmd` and `scripts/git-shim/git` put one PATH entry in front of the worker on both platforms, forwarding to the guard. `src/conductor.ts`'s `buildWorkerEnv` puts the shim first on the worker PATH, drops credential-bearing variables, sets `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` to the platform null device, sets `GIT_TERMINAL_PROMPT=0`, and hands `gh` an empty config directory; `runLane` snapshots HEAD and the checked-out ref before dispatch. `scripts/check-evidence.ts` compares the after state, exits 3 on a moved HEAD, changed ref, populated index, or non-empty guard log, and runs that check before the existing no-changes branch. This satisfies enforcement layers 2, 3, and 4 from [05-safety-and-git-policy.md](05-safety-and-git-policy.md); layer 1 (the brief) and layer 5 (Claude owns the commit step) were already in place.

Measured on Windows, 2026-08-07, with the shim first on PATH and `LANEWARD_REAL_GIT` unset: `git rev-parse --abbrev-ref HEAD` succeeds (exit 0), `git commit --allow-empty -m x`, `git push`, and `git worktree add ..\evil` are each refused with exit 86 and their own JSON line in the guard log; HEAD is unchanged afterward. Credential isolation was measured separately: on this host, `git config --get credential.helper` still returns Git Credential Manager with `GIT_CONFIG_GLOBAL=NUL` alone, because the helper is configured in the system file rather than the global one; only setting both `GIT_CONFIG_GLOBAL=NUL` and `GIT_CONFIG_SYSTEM=NUL` clears it. Targeted guard tests: 18 of 18 pass. Full suite in this worktree: 36 pass, 16 fail, against a pre-Phase-2 baseline of 15 pass and 16 fail; all 16 failures are environmental (14 pre-existing `DATABASE_URL is not set`, 2 `Cannot find package 'hono'` from a worktree with no `node_modules`), no new failure class.

One trap, the same shape as the Phase 2b trap above where a test resolved a path differently from the production caller: the guard's `resolveRealGit` fallback derived the shim directory from `dirname(import.meta.path)`, which is `scripts/`, but the shim lives in `scripts/git-shim/`. The shim survived the PATH filter and the guard resolved itself. On Windows this showed up as "The system cannot execute the specified program" rather than as recursion, because Bun cannot exec a `.cmd` directly, and the permitted-command path was completely dead whenever `LANEWARD_REAL_GIT` was unset. The test suite stayed green throughout because its helper always injected `LANEWARD_REAL_GIT`, so tests resolved git a different way than production did. A regression test that removes the variable now covers it. Also fixed: the POSIX shim was committed as mode 100644, which fails exec with permission denied on Linux, and would have picked up a CRLF shebang terminator from this repository's `core.autocrlf=true`; a `.gitattributes` entry now pins that file to LF with mode 100755, though this defect was never observable on Windows.

The misreport this phase set out to fix is now fixed: `scripts/check-evidence.ts` reports a Git-state violation as a violation, with its own distinct reason, rather than as an empty result.

Linux was measured later the same day, in a Fedora 44 WSL distribution, from a clone on the Linux filesystem rather than under `/mnt/c`, because `/mnt/c` does not carry the executable bit and would have made the shim look fine when it was not.

The two defects fixed blind for Linux both held up: the shim arrives as `-rwxr-xr-x`, `file` reports it as an executable POSIX shell script, and the shebang terminates with `\n` and not `\r\n`. With the shim first on `PATH` and `LANEWARD_REAL_GIT` unset, `git rev-parse --abbrev-ref HEAD` and `git status --porcelain` both exit 0 with empty stderr, while `commit`, `push`, `worktree add`, and `-c core.pager=whoami status` are each refused with exit 86 and their own JSON line in the guard log. HEAD was unchanged afterward. Guard tests: 18 of 18. Whole suite on Linux: 116 passing, 0 failing.

One part of this phase remains Windows-only: the credential isolation was measured against this host's Git Credential Manager, which is a Windows arrangement. `buildWorkerEnv` sets the same variables on Linux, and nothing there has been observed.

Not yet true: the repository-local git config, including the remote URL, remains readable from inside a lane worktree; that exposure is unchanged and is not what this phase addressed. The shim is defense in depth, not the sole control: the Codex sandbox independently denies these mutations (measured 2026-08-07, see [../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md](../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md)), and Laneward's post-exit state validation is the third layer; the shim matters because the sandbox was observed absent on this host for hours. At the time of this Phase 2 status, 2026-08-07, `scripts/new-lane.ts` had never run end to end; the Phase 2b status below records it doing so on Windows later the same day.

## Phase 2b — Make the scripts cross-platform

D-022 makes Windows a first-class target, and the Bash scripts are what currently prevent Laneward from running there at all. This lands before Phase 3 because Phase 3 moves lane-check execution into the conductor, and it should not be built on top of scripts that are about to be replaced.

Rewrite `scripts/new-lane.sh`, `scripts/check-evidence.sh`, and `scripts/codex-round.sh` in TypeScript. Replace `jq` and `curl` with Bun's JSON handling and `fetch`, and shell calls to `git` with `Bun.spawn` using argument arrays rather than interpolated command strings.

Paths on the Windows host contain spaces. String-interpolated commands are where that turns into a defect, so argument arrays are a correctness requirement here, not a style choice.

Acceptance evidence:

- lane creation and evidence checking run on Windows and on Linux from the same code;
- no remaining dependency on Bash, `jq`, or `curl`;
- a path containing spaces is handled correctly on both platforms;
- the existing behavior of each script is preserved, including the `.env` guard in `new-lane.sh` and its failure cleanup.

The database and persistence layers are deliberately not part of this phase. They are per-OS packaging decisions, not a TypeScript rewrite problem.

### Status: Windows half done, 2026-08-07

Delivered on `lane/phase2b-cross-platform-scripts`. The three scripts are now `scripts/check-evidence.ts`, `scripts/new-lane.ts`, and `scripts/codex-round.ts`; no `.sh` file remains under `scripts/`, and `tests/fixtures/fake-codex.sh` was replaced by a TypeScript fixture.

Measured on Windows, whole suite: 2 passing and 28 failing before, 15 passing and 16 failing after. Every remaining failure is `DATABASE_URL is not set`, which is the database layer this phase deliberately excludes. `tests/check-evidence.test.ts` goes from 0 of 6 to 7 of 7, the seventh being a new case for a worktree path containing a space.

Two decisions worth carrying forward:

- `CODEX_BIN` values ending in `.ts` are invoked as `[process.execPath, path, ...args]`, everything else stays a direct executable. A TypeScript file is not executable on Windows, and this avoids depending on file associations or executable bits.
- `bun run --env-file=/dev/null` became `bun run --no-env-file`, which is a real Bun flag and needs no shim.

One trap, recorded because it survived the rewrite it was meant to remove: `new URL(path, import.meta.url).pathname` yields `/C:/...` on Windows, with a leading slash that no API can resolve. It appeared in six places including `src/conductor.ts`'s evidence-script constant, where it broke the production path while the test still passed, because the test resolved the same file a different way. Use `join(import.meta.dir, ...)`, which the rest of this codebase already does.

`scripts/new-lane.ts` ran end to end on Windows on 2026-08-07, once Postgres was brought up in a container. Both paths are now verified against a throwaway target repository whose path contained a space, with the worktree root also containing a space.

The success path created the worktree, copied the parent repository's `.env` into it, ran `bun install`, and registered the lane with Laneward, which then listed it as dispatchable with the spaced path intact. The failure cleanup path was exercised by making Laneward reject the registration (`LANE_TYPE=bogus-type`, HTTP 400): the script exited 1 and left behind neither a worktree nor a branch.

The `.env` copy is worth naming plainly, because the test observed it directly: the parent repository's secret values land inside the lane worktree, which is the exposure already recorded as a known limitation in the README.

Bringing the database up also corrected a long-standing blind spot in the test numbers. Every measurement in this document before 2026-08-07 was taken with `DATABASE_URL` unset, which aborted 16 files at import, so most of the suite had never actually run. With Postgres reachable the suite reports 114 passing and 2 failing.

Both failures reproduce on `db40c6c`, the commit before any Phase 2 work, so neither belongs to the Git boundary changes. They are pre-existing and specific to Windows:

- `tests/dashboard.logs.test.ts` expected `logPath` to produce a POSIX separator, and it produces a backslash here;
- `tests/conductor.signals.test.ts` expects a lane to return to `pending` after SIGINT, and it stays `running`.

Under D-022 both are real defects rather than acceptable platform noise. The first is fixed; the second is a documented Windows limitation, not fixed, because it cannot be:

- `logPath` is only ever used as a filesystem path (`Bun.file`, `writeFile`), never as a URL, so a platform-native separator is the correct implementation. The test's hardcoded `/var/logs/gig-radar.log` expectation was the defect, not the code; it now builds its expectation with `node:path`'s `join` so it asserts the same thing on both platforms.
- **`conductor.signals.test.ts` is skipped on `win32`, with the safety property it checks not holding there.** Probing a bare `process.on("SIGINT")` handler in a Bun-spawned child confirmed the mechanism: `Bun.Subprocess.kill("SIGINT")` on Windows terminates the child unconditionally (the child exits 130 and its handler never runs), because Windows has no POSIX signal delivery and Bun's `kill()` on that platform does not raise a catchable event. `installSignalHandlers`'s cleanup in `src/conductor.ts` therefore never gets a chance to run before the child dies. Making this work would need native Windows console-control APIs (e.g. `GenerateConsoleCtrlEvent` against a process group), which is out of reach without a new dependency. **Consequence: on Windows, Ctrl-C during a conductor run does not hand the interrupted lane back to HUB as `pending`; the lane is left `running` and needs manual cleanup before the next run.** HUB has no staleness detection for a lane orphaned this way.

Linux was measured on 2026-08-07 in a Fedora 44 WSL distribution, with git 2.55.0 and the same Bun 1.3.14 the Windows side runs. The whole suite passes there, 116 of 116, including the two tests that fail or skip on Windows, which is what confirms both of those are genuinely Windows-specific rather than defects in the code under test.

What that run does not cover: `scripts/new-lane.ts` has not been exercised end to end on Linux, and no Codex worker has been dispatched there. The scripts are the same TypeScript on both platforms and the suite exercises their logic, but the live paths are Windows-only evidence so far.

Running the suite at all requires a database. On this host that is a Postgres container reached on the podman machine's WSL address rather than on `localhost`, because published ports do not reach the Windows host. The address changes when the machine restarts, so `.env` needs re-checking after one.

## Phase 3 — Implement test, commit, and integration flow

This is the phase that closes the gap between a verified file scope and a delivered change.

Add:

- `ready_for_review`;
- automatic lane-check execution;
- Claude review recording;
- Claude-only commit transition;
- integration branch creation;
- full integration gates;
- separate merge, push, and runtime approvals;
- worktree and branch cleanup after a plan closes.

### Who runs the checks

The conductor runs the deterministic lane checks defined by the project as soon as a worker exits. Their results are stored as lane evidence.

Claude does not run them. Claude reviews the diff, the brief, and the recorded results, and decides.

This is what makes D-014 real: verification keeps progressing while Claude Code is closed, and a returning session finds evidence rather than a queue of unstarted work.

### Cleanup

A lane worktree, its branch and the database provisioned for it are removed once the plan reaches `done` and the lane commit is integrated. Removal is an operator command rather than a consequence of the plan closing, and it refuses a lane that still holds uncommitted or unintegrated work: see D-025. Evidence and logs outlive the worktree; removing a worktree must never remove the record of what happened in it.

Acceptance evidence:

- a successful worker exit cannot become a commit without checks;
- lane checks run without a Claude session present, and their results are inspectable afterwards;
- a failed check returns to bounded correction;
- merge and push remain blocked without user approval;
- completion remains blocked without runtime verification;
- a closed plan leaves no orphaned worktree, and its evidence is still readable.

### Status: deterministic lane-check slice done on Windows, 2026-08-08

Delivered in the Phase 3 automatic-lane-checks lane. A driven checkout can declare argument-array commands in `.laneward/project.json` under `checks.lane`. The conductor runs those commands only after the worker, escalation, Git-boundary, no-change, and owned-path gates have cleared; each command has a configurable timeout and writes interleaved output to its own durable log. The conductor records the structured verdict as an `EVIDENCE` message before posting either the successful lane result or a failed/unrunnable approval request. `GET /lanes/:id/evidence` reads those records newest-first from Postgres without conductor memory, and this repository now declares `bun test` as its own lane check. No schema or lane-status change was made.

Measured in the Windows Codex sandbox on 2026-08-08. The three changed source entry points bundle successfully with Bun. The database-backed evidence-route tests pass 2 of 2, including an object-valued `jsonb` insert/read round trip and the route taking priority over the dashboard mount. Three non-spawning manifest and spawn-error tests also pass. The required three-file target reports 5 passing and 10 failing because this sandbox rejects every child process created by Bun with `uv_spawn ... EPERM`; the failures include both the new check processes and the pre-existing Git fixtures. The whole-suite baseline in the same sandbox was 62 passing, 54 failing, and 1 skipped across 117 tests; after this slice it is 67 passing, 64 failing, and 1 skipped across 132 tests. Every added failure is the same sandbox child-spawn denial already present in the baseline. This does not reproduce the last host baseline of 114 passing and 2 failing and is not a host pass.

The host verification the lane could not perform was completed outside the sandbox the same day, on Windows. Whole suite: 131 passing, 1 skipped, 0 failing, against the 116 passing and 1 skipped baseline; the skip is the pre-existing Windows `conductor.signals` case. The three new files pass 15 of 15, including the timeout case, which the lane's own version could not run.

Two defects were fixed during that verification. The timeout test set `LANEWARD_CHECK_TIMEOUT_MS` to 30ms and then read a pid file the child never lived long enough to write; the budget is now 2000ms, which the child beats while the test stays fast. The two conflicting assertions in `tests/conductor.lane.test.ts` were rewritten: a non-escalating lane now asserts the absence of an `APPROVAL_REQUEST` row rather than the absence of any `/messages` request, because a worktree with no manifest legitimately posts one `not_configured` evidence message.

All four live observations were then made on Windows with the conductor process exited and only HUB running, against four throwaway repositories whose paths contain spaces. A check exiting 0 leaves the lane `completed` with `overall: "passed"` and an `output_path` whose file holds the check's real stdout. A check exiting 1 parks the lane in `waiting_approval` with `overall: "failed"` and the question `lane e2e-fail failed its lane checks: unit`. A check whose binary does not exist parks it with `overall: "unrunnable"` and the distinguishable question `lane e2e-unrunnable could not run its lane checks: Executable not found in $PATH: "laneward-no-such-binary-e2e"`. A lane whose index was populated at exit is `failed` with the Git-boundary `FAILURE` message and an empty evidence array, confirming the boundary still wins and writes no check evidence.

Not yet true: nothing here was observed on Linux, and no real Codex worker has run this path; every live observation above used the fake-codex fixture. The rest of Phase 3 remains deliberately absent: there is no `ready_for_review`, Claude review or commit transition, integration flow, additional approval classes, or cleanup.

One operational trap was found the hard way while running this lane, and it is not specific to Phase 3. `scripts/new-lane.ts` copies the parent repository's `.env` into the lane worktree, so a lane driving Laneward itself runs the test suite against Laneward's own live database. The suite truncates `lanes`, `messages`, and `approvals`, which deleted the running lane's own row mid-flight; the conductor's escalation POST then failed with HTTP 500 against a lane that no longer existed, and a leftover test lane was picked up as dispatchable and dispatched three times. Verification here used a separate `laneward_test` database.

This is now fixed by construction. `scripts/new-lane.ts` rewrites the `DATABASE_URL` in the lane's copied `.env` to a database named `<database>_lane_<lane_id>`, creates it, and runs the driven repository's `db:migrate` script against it when the repository declares one. Observed live on Windows against the running hub: a lane opened on Laneward itself reported `Database: laneward_lane_dbtest`, its worktree suite ran 131 passing and 0 failing against that database, and the hub's own `lanes` table still held the lane's row afterwards. One defect was found doing this: Bun does not let a `.env` file override a variable already present in the environment, so the first attempt migrated the hub's database instead of the lane's and left the lane's empty, 74 tests failing. The migration now receives `DATABASE_URL` explicitly. Lane databases are not dropped when a lane finishes; only a failed `new-lane.ts` run cleans up after itself.

## Phase 4 — Pilot on a real small project

Choose a bounded but real project with installation and runtime verification.

The pilot runs before the plan records and the bridge are built, so that their design answers problems that actually occurred.

Pilot goals:

- exercise planning and reapproval, using whatever records exist at this point;
- run at least two independent lanes if justified;
- close Claude while workers continue;
- resume and review results;
- create Claude-only commits;
- require merge/push/runtime approval;
- verify the installed result;
- record every point where the manual process hurt.

Do not use a toy task that avoids the hard parts.

### Status: two lanes run on neura-system, 2026-08-08

The pilot project is `neura-system`, and the work was its own Phase 1 data
layer rather than a task invented for the pilot. Two lanes ran, one after the
other: the Apache AGE + pgvector image with a migration runner, then the
NeuraCore memory schema with the audit trail. Both were driven by real Codex
workers, both escalated honestly for verification they could not perform, both
were resumed with a decision and delivered, and both are merged into
`neura-system` `main` with their worktrees and branches removed. The full
account, including every defect on both sides, is in
[../../notes/2026-08-08-phase4-pilot-neura-system.md](../../notes/2026-08-08-phase4-pilot-neura-system.md).

Four defects in Laneward were found by running it and are fixed: an escalating
worker recorded no evidence at all, the lane opener's own `bun install`
lockfile failed the worker for a file it never touched, a lane could be
registered against a worktree that does not exist, and per-lane database
isolation only recognised a single `DATABASE_URL` rather than the split
`DATABASE_HOST`/`DATABASE_NAME` form the pilot project uses.

Of the pilot goals, these are done: two independent lanes, resume and review
after an escalation, Claude-only commits, merge behind explicit user approval,
runtime verification of the delivered result, and the record of where the
manual process hurt. These are not: planning and reapproval, which have no
records to exercise yet, closing Claude while a worker continues, which was
never tested because the conductor ran in the foreground each time, pushing,
which the user deliberately withheld, and lane-level concurrency, since the two
lanes ran sequentially.

## Phase 5 — Add first-class plans to Laneward

Design and implement, informed by the pilot:

- plan and revision records;
- approval records tied to a revision;
- plan lifecycle states;
- lane-to-plan relationships;
- reapproval behavior;
- plan-level concurrency and risk;
- integration and runtime state.

Add a status only when a concrete operator action sits behind it. The pilot decides which of the statuses proposed in [04-plan-and-lane-model.md](04-plan-and-lane-model.md) earn their place.

Acceptance evidence:

- an approval can be traced to an immutable revision;
- a material plan change invalidates the previous execution authority;
- lanes cannot dispatch from an unapproved revision.

### Status: the three acceptance bullets are met, 2026-08-08

`plans` and `plan_revisions` exist, a lane carries an optional
`plan_revision_id`, and `checkGate` refuses a lane whose revision is unapproved
or no longer the plan's newest. Because `POST /lanes/:id/start` and the
conductor both go through the gate, that single rule covers all three bullets:
the approval lives on one immutable revision row, a material change is recorded
as a new revision and thereby withdraws the old revision's authority, and an
unapproved revision never starts a lane. Verified live against a running hub,
not only in tests: gate open on the approved revision, closed with
`lane's plan revision 1 is superseded by revision 2` the moment revision 2 was
created, with revision 1's approval still on record.

Deliberately not built. The twelve plan statuses and ten lane statuses proposed
in [04-plan-and-lane-model.md](04-plan-and-lane-model.md) have no operator
action behind them yet, and this section's own rule says not to add them until
they do. `plan_revisions.content` is a free-form `jsonb`, so risk level,
concurrency limit, network policy and the runtime verification contract are
recorded but not enforced; the fields become columns when something reads them.
Revision immutability is upheld by there being no route that writes `content`
after insert rather than by a database trigger, because `db/migrate.ts` splits
`db/schema.sql` on `;` and cannot carry a plpgsql body.

Two debts the pilot recorded were closed alongside it: `POST /approvals/:id`
answers 400 instead of 500 for a `resolved_by` outside the check constraint, and
`DELETE /lanes/:id` finally makes a lane record correctable. Approvals now carry
`verified_by` next to `resolved_by`, so a decision the user approved is
distinguishable from one Claude reached on its own. Still open: nothing drops a
finished lane's database.

## Phase 6 — Build the Claude Code ↔ Laneward bridge

Implement structured commands or MCP tools plus the required hooks.

The hook events listed in [02-target-architecture.md](02-target-architecture.md) were verified on 2026-08-08 against Claude Code 2.1.226. All of them exist, so nothing has to be substituted. `WorktreeCreate` was first wired as the hard gate on lane worktree creation; that was wrong and has been removed. The event takes over worktree creation rather than vetting it, so a permission-only hook there aborts every worktree Claude Code tries to make. `PreToolUse` was then tried in its place and also removed: it fits the contract, but a fail-closed gate on the editing tools locks the main checkout whenever the hub is down. Only the non-blocking `SessionStart` hook is wired, and lane authorization stays with `checkGate` on the hub.

Acceptance evidence:

- Claude can load current project state;
- Claude can create a draft plan and submit it for approval;
- approved lanes are created without a second write-worktree owner;
- session restart restores actionable context;
- hard gates fail safely when Laneward is unavailable.

## Phase 7 — Dashboard and Linux notifications

Extend the dashboard and add desktop attention events.

Acceptance evidence:

- dashboard shows plans, revisions, lanes, evidence, and approvals;
- only approved notification classes generate desktop alerts;
- dismissed notifications do not lose state;
- secrets do not appear in notifications.

## Phase 8 — Refactor ACOS through Laneward

This phase no longer supplies Laneward's verification layer. D-028 settled that
question by measurement: the layer is the independent clean run followed by an
advisory reader, and ACOS is not one of its candidates. What remains here is
refactoring ACOS as its own project through Laneward, which is a second pilot,
not an audit-layer dependency. See D-021 for its state.

After the pilot is stable:

- create an approved Laneward plan for ACOS;
- add Laneward-specific inputs and result links.

Verification itself begins in shadow mode and measures usefulness before granting
blocking authority, per D-028, independently of this phase.

## Deferred by decision

### Worktree ownership transfer

D-003 describes Laneward as the owner of write worktrees. As of 2026-08-15 `scripts/new-lane.ts` creates them and Laneward only records the path.

The script works and is not the source of any current failure, so the transfer is deferred. Until it happens, "Laneward owns write worktrees" means Laneward is the only registry of them, not their creator.

### Secret isolation

Workers can read the repository `.env`. Redaction, scoped credentials, and fixture values are deferred; the exposure is recorded as a known limitation in the README instead.

### Two small items from the Phase 2 measurements

Neither is urgent and neither blocks Phase 3, but both were observed rather than predicted, so they are recorded here instead of being rediscovered later.

The guard's allowlist now admits `git --version`, `rev-list`, `worktree list`, and `stash list`. Deny by default remains in place: mutating `worktree` and `stash` operations, bare invocations of either command, unknown or absent subcommands, and global options that can smuggle execution through a read command are still refused.

`buildWorkerEnv` hardcodes the string `NUL` for the null device on Windows. Reads were measured and behave correctly, which is what the credential isolation depends on. The risk is a write: on Windows a tool that does not special-case the name creates a literal file called `NUL` in the working directory, which is exactly what `podman machine ssh` did during this session. `os.devNull` would be the more robust source for that value, and changing it means re-running the credential measurement.

## Explicit exclusions

### GPT Pro

Disabled because no active subscription exists. It is not required for any phase.

### OMP

Removed completely. It is not a deferred roadmap item.

## Evidence required before increasing autonomy

Merge, push, deployment, or verification blocking authority should not become automatic merely because the system “feels stable.”

Track at least:

- successful plan completion rate;
- user interventions;
- escaped defects;
- false completion attempts blocked;
- incorrect approvals requested;
- rollback events;
- verification-layer false positives and false negatives, read against the escaped-defect ledger per D-028.

Automation should expand only where evidence shows that the relevant gate is reliable.
