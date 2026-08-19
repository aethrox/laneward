# Approved Decisions

This file is the durable record of the decisions approved during workflow design.

## Authority and entry point

### D-001 — Every new task starts in Claude Code

Claude Code is the only normal user entry point. It collects context, researches, asks clarifying questions, and prepares the plan.

### D-002 — The plan is shown before execution

Claude must not create write lanes before the user approves the plan. The user may be asked additional questions during planning.

### D-003 — Laneward owns all write worktrees

Laneward is the only authority allowed to create and register worktrees used for write execution.

Claude's native worktree-isolated subagents must not create a second write-worktree system.

Current state (2026-08-15): only the registration half holds. `scripts/new-lane.ts` still creates the worktree and Laneward records the path. Moving creation into Laneward is deferred; the rule that no second write-worktree system may exist applies now.

### D-004 — Read-only Claude subagents may run natively

Claude may use native subagents for research, exploration, and review. Their lifecycle is mirrored into Laneward, but Laneward does not need to dispatch them in v1.

## Plans and lanes

### D-005 — Plan is a first-class Laneward entity

A plan has an identity, revision, approval record, risk level, target branch, lanes, checks, runtime verification, and final status.

### D-006 — Material changes require reapproval

A new approval is required when a plan changes its goal, write scope, owned paths, dependencies, external effects, security policy, deployment behavior, or risk.

Mechanical implementation details that remain inside the approved scope do not require reapproval.

### D-007 — Concurrency is selected by project scale

Claude proposes concurrency based on lane independence and machine capacity.

Initial guidance:

- small change: 1 lane;
- medium feature: up to 2 lanes;
- large work with genuinely independent scopes: up to 3 lanes;
- deployment and Linux service operations: normally 1 lane;
- more than 3 lanes: explicit user approval.

## Git and integration

### D-008 — Codex never performs Git mutations

Codex may inspect Git state when needed, but it must not create branches, commits, merges, rebases, tags, pushes, resets, or worktrees.

Current state (2026-08-15): enforced on Windows. `scripts/git-shim/` puts a deny-by-default `git` on the worker's PATH, `scripts/check-evidence.ts` validates Git state after the worker exits, and `buildWorkerEnv` keeps credentials out of the worker environment. See D-023. The guard's own tests also pass under Linux, measured 2026-08-15 ([notes](../../notes/2026-08-15-linux-suite-run.md)); no lane has been driven end to end there.

### D-009 — Claude may commit only after gates pass

A Claude-created commit requires:

1. the lane-specific tests to pass;
2. the owned-path and diff checks to pass;
3. Claude to review the result against the approved brief.

### D-009a — The conductor runs the deterministic checks

Lane checks defined by the project run automatically when a worker exits, and their results are stored as lane evidence.

Claude does not execute them. Claude reads the recorded results, reviews the diff against the brief, and decides.

Without this, D-014 is only half true: work would continue while Claude is closed but nothing would be verified, and a returning session would face a queue of unverified lanes instead of evidence.

### D-010 — Each plan uses an integration branch

The branch format is:

```text
integration/<plan-id>-<short-name>
```

Claude brings verified lane commits into this branch. Full integration checks run there.

### D-036 — Owned paths never overlap, and a serialized plan is not an exception

`POST /lanes` rejects a registration whose `owned_paths` overlap any lane that is not `completed` or `failed`, with a `409` naming the conflicting lane. That includes lanes that could never run at once because of their dependencies.

`05-safety-and-git-policy.md` previously permitted the overlap when the plan explicitly serialized the lanes. That permission is withdrawn. Two rules were written down, the code held the stricter one, and the stricter one is the right one: serialization is an ordering claim made in a plan document, and nothing in the gate re-checks it if the plan is later revised or a dependency is dropped. An overlap rule that depends on a claim made elsewhere is not a control.

The cost is real and accepted: a plan that genuinely needs two lanes over the same file must split the file, split the lanes differently, or run them one after the other with the first torn down. Overlap is refused at registration rather than at dispatch so the operator learns it while writing the plan.

Decided 2026-08-15, resolving a conflict raised by issue #12.

### D-011 — Merge and push require user approval

Merge and push remain explicitly user-approved. Automation may be reconsidered only after the system has accumulated trustworthy evidence.

### D-026 — The independent reader's declared subject is the test diff

The review layer's reader reports first on one question: does this change weaken what the suite proves? A deleted assertion, a loosened matcher, a narrowed input, a test rewritten to agree with the code it just broke. The source diff stays in scope as context and is not dropped.

The subject is the test diff because 4 of the 30 escapes surveyed in issue #3 — recorded locally in [the escaped-defects survey](../../notes/2026-08-09-escaped-defects-survey.md) — were tests lying about what they proved, a class no run, linter, or coverage tool can see. D-024's own delegation came back with an assertion silently deleted while the suite stayed green. The source diff is kept because the one candidate that read it found three true defects outside the ground truth, including a cross-file contract disagreement between `plan_ready_for_review` and `checkGate`.

A deterministic counter for removed assertions was considered and deliberately not adopted: the class is real but such a counter's false-positive rate has never been measured here, and it would not see a loosened matcher at all.

### D-027 — The model layer advises permanently and never gates

A reviewer that answers the same question differently on the same input cannot hold blocking authority in this system. Blocking authority belongs only to checks measured to repeat identically: the deterministic tools and the independent clean run.

The measurement is the bake-off's, not an assumption: the reader returned 5 findings then 4 with roughly half in common, and a ground-truth defect appeared in one run and not the other. A single run of that candidate is a sample, not a result. The bake-off is recorded in [2026-08-09-verification-bakeoff.md](../../notes/2026-08-09-verification-bakeoff.md).

An empty reader report is recorded as `no_findings` and never as `pass`. The reader cannot produce a clean verdict at all, so a sampling that happened to surface nothing cannot be read as a passed check.

### D-028 — Verification runs the clean run first, then the reader, in shadow mode

Two layers run on the integration candidate D-014 builds:

1. the **independent clean run**, gate-capable, ~12 seconds and free, measured identical across runs;
2. the **Codex reader lane**, advisory per D-027, on every candidate, ~4 minutes and ~85k tokens.

The clean run goes first and the reader does not run when it fails. A candidate that does not build or does not run cannot be integrated whatever a reader says, so reading it is spend with no decision attached. The record states that the reader did not run and which layer fell. This ordering is the only cost lever adopted; a per-revision budget ceiling, narrowing the reader's input to the diff alone, and a cheaper reviewer model were all considered and rejected, the last because changing the model invalidates the measurement the whole decision rests on.

The layers are complementary, not competing: the clean run caught 2 of 3 known defects including the one that broke the tool for its operator, the reader caught the one it could not reach and the lying test. Deterministic tools are deferred rather than rejected: `tsconfig.json` names a `bun-types` library no package provides, so the typecheck does not run at all as the repo stands.

ACOS is not a candidate. It cannot spawn its agents on this host, its output contract does not survive this host's agent configuration, and it reviews a whole exported revision rather than a change. That third reason is what it is designed to be, and it does not stop being true when the first two are fixed.

The first use is shadow mode: it runs, it records, it stops nothing. Its findings are read against the escaped-defect ledger that issue #3 opened, asking of every defect found after integration whether the check had said so. Reversal costs nothing structural: the conductor stops invoking it and the record stays.

Evidence: issue #4.

### D-029 — The clean run's environment is declared in the repository

One committed file declares what the independent clean run of D-028 needs: the database address and how a fresh one is provisioned, the install path, and the shell the run starts from. Reproducibility on a host that is not this one is a property of the project, so it does not live in a plan revision or a lane brief, which are per-piece-of-work and would carry the same text repeatedly.

The bake-off is the evidence that nothing declares this today. Standing up one clean run by hand required discovering, none of it written down: the database answers at the podman machine address rather than the documented `localhost:5433`, the suite refuses a `DATABASE_URL` whose database is not `laneward_test`, `*_test` or `laneward_lane_*`, `bunx` does not exist under git-bash while `bun x` does, and D3 only appears at all from git-bash. A clean run started from PowerShell would have reported success.

The run exercises **the whole documented configuration surface**, not the defaults. D1 was caught only because all five documented notification classes were enabled and two of them emitted nothing; a run on defaults would have missed it. The cost is that the run grows with the surface, which is accepted: the surface is documented, so it is bounded and visible.

### D-030 — A candidate that cannot be built raises an approval request

Construction failing is not the check failing and not `unrunnable`. The artifact the check exists to examine never came into being, so there is nothing to be unrunnable about.

It does not fail the plan. Completed lanes did their work and a failed build usually says something about the host or about two lanes that each appended to a shared file, not about the plan being wrong. It also is not retried automatically: the failure class the bake-off actually hit twice on this host was environmental, and a silent retry loop is how a permanent environment fault becomes invisible. The conductor stops, records what failed, and raises an approval request for a human, which is the same shape D-011 already uses for merge and push.

The half-built candidate is left in place, its branch and its fresh database both, and recorded. This is D-025's reasoning applied to new debris: nothing is deleted at a moment nobody is watching, and the half-built candidate is exactly what the person resolving a lane-to-lane conflict needs to look at. Removing it is an explicit command.

### D-031 — The check's record is a run per layer plus findings as rows

Two shapes, because the layers emit different things and the lane precedent's single verdict does not survive contact with a reader.

A **run record per layer**, scoped to the plan revision per #5, carries the state: it ran, `no_findings`, it did not run because the layer before it fell (D-028's ordering), or the candidate was never built (D-030).

A **finding is a row** with its own lifecycle: `open`, `accepted`, `rejected`, `deferred`. A rejected state is required rather than convenient. The bake-off's reader re-raised the unregistered AppUserModelID worry this project had already measured and closed, and without somewhere to say "adjudicated and rejected" that false positive returns on every run forever.

A rejected finding is remembered by being **fed into the next run's input as context**, not by matching identity. A sampling reviewer's findings have no stable id, per D-027, so a fingerprint would be matching something that does not exist; the cost of a wrong match is a real finding silently suppressed, which is worse than a repeat.

Findings about code the change did not touch stay in the record, marked out of change, and count neither for nor against the candidate. The reader's sharpest true finding in the bake-off was exactly this class, and throwing it away to keep the record tidy would discard the thing that was worth having.

Delivery follows the `notifications` table's `subject_kind` precedent from D-024: one new class scoped to the plan revision, saying verification finished and findings are waiting to be adjudicated. Today's classes are per lane and per plan, and neither is the subject here.

### D-032 — The integration candidate is one command before it is automatic

`scripts/build-candidate.ts`, reachable as `bun run build-candidate <plan_id>`, builds the artifact every layer of D-028 examines: the newest revision of the plan, all of its lanes `completed`, merged onto `integration/<plan_id>-r<revision>` in a worktree named `candidate-<plan_id>-r<revision>`, installed, with a fresh database of its own. The base commit is the checkout's `HEAD` at build time, and it is the commit the diff D-026 reads is taken against.

It is a command first and the conductor's job second, though issue #5 settles that the conductor will own it. Construction is the part whose failure modes nobody has seen yet, and the argument that put teardown behind an explicit command applies while they are still being discovered: a person watching the first candidates get built learns what D-030's approval request has to say. Automating construction before that would automate a shape guessed rather than observed.

The candidate database's name ends in `_test`. The clean run is the repository's own suite run inside the candidate tree, and `src/db.ts` refuses under test any database whose name is not recognisably disposable, so a candidate database without that tail is a candidate nothing can check. Its full suffix, `_candidate_<plan>_r<n>_test`, is derived in one place beside `laneDbSuffix` for the reason that one exists: teardown recognises what it may drop by the suffix, and a second derivation aims a `DROP` somewhere nobody intended.

A refusal that changed nothing exits 1; a build that started and failed exits 2 and leaves everything it made, per D-030.

`plan_id` is now validated as a slug where a lane id already was. It names the candidate's branch and worktree directory, so a plan the hub accepts but no candidate can be built for is a plan that dead-ends at integration.

### D-033 — The conductor builds the candidate at the end of a drain pass

D-032 said the command comes first and the conductor second. This is the second half, settled in four grilling rounds once the command existed and its failure modes could be reasoned about concretely.

**The trigger is the end of a drain pass, level-triggered.** When `drain` has nothing left running, the conductor asks the hub which plan revisions are due: newest revision of their plan, every lane `completed`, no construction attempt recorded. It builds each one before exiting.

The hub's own notifier already computes that exact condition for `plan_ready_for_review`, one second at a time, and putting construction there was rejected: a merge, an install and a `CREATE DATABASE` take minutes, and the notifier's loop belongs to a process that answers requests. Level-triggering rather than reacting to the moment a lane completes is what survives the conductor dying mid-pass; the state, not the event, is what says a candidate is due.

The cost is stated plainly: the conductor is a one-shot command, so nothing is built while nobody runs it. That is the background supervision gap issue #12 already names, not a gap this decision opens.

**The record is one row per revision, per layer, per attempt.** `verification_runs` carries `construction` today and `clean_run` and `reader` later without a second schema change, which is D-031's per-layer run record arriving one layer early. A repeated attempt appends rather than overwrites, following the `notifications` table's `occurrence`: a revision that failed to build three times is a permanent environment fault stating itself, and an overwriting row would show each failure as the first.

That record, not the presence of the branch on disk, is what stops a candidate being rebuilt every pass. Disk state lies: a worktree removed by hand would put the conductor back to rebuilding forever.

**A failed construction raises a plan-revision-scoped approval request.** `approvals` gains the discriminator rather than a table of its own, so "what is waiting on a human" stays one query; `/pending` and the dashboard are updated in the same change, because a subject those queries cannot see is a request nobody is asked. Delivery reuses `approval_required` rather than adding a class: the meaning is identical, and a new class defaults to off, so the first real build failure would have arrived silently.

**A successful build is silent.** The candidate has passed nothing yet, and `plan_ready_for_review` fired seconds earlier on the same condition. D-031's new class stays reserved for verification finishing, which is a claim this layer cannot make.

**Rebuilding is explicit and refuses an open approval.** `bun run build-candidate <plan_id> --rebuild` clears the failed attempt and builds again. It refuses while the approval request is unresolved, which is the other face of D-030's ban on automatic retry: acknowledging a failure and retrying it stay two acts, or the environment fault the pause exists to expose gets clicked past. Once acknowledged, `--rebuild` removes the previous attempt's branch, worktree and database itself, naming each before it does, because it is already a deliberate human command and D-030's objection was to deleting at a moment nobody is watching.

**An interrupted attempt is recovered by `reset-stranded`.** A `running` construction row left by a Ctrl-C, a Windows restart or a stopped podman machine is stranded in exactly the sense that command already exists for. Having the conductor reclaim it on the next pass was rejected because a second conductor would then declare a live build dead; a liveness stamp was rejected because its threshold would be invented rather than measured.

### D-034 — The clean run declares what must be observed, not what must not appear

D-029 said one committed file declares the clean run's environment. That file is `.laneward/project.json`, which already declares this project's lane checks, under a `clean_run` key. A second file was rejected for the reason D-029 gave against a plan revision: the declaration is a property of the project, and the project already has exactly one place that says how it is checked.

**The verdict comes from expected observations.** The declaration lists what must be seen while the candidate runs, and a missing one is a failure. This is the only rule that reproduces the bake-off's result: D1 was two notification classes emitting nothing, and silence matches no error pattern. A list of failure patterns alone was considered and rejected on that measurement, though an expectation may also be a pattern that must *not* appear, which is how a D3-shaped defect is caught.

The cost is accepted and named: the declaration grows with the configuration surface, and an expectation nobody maintains becomes a failing layer that gets ignored. That is the bargain D-029 already made when it said the run exercises the whole documented surface rather than the defaults.

**The clean run does not run the suite.** The suite runs per lane and again on demand, and the bake-off measured this layer's value to be exactly what the suite cannot see: the process starting, the shell it starts from, and behaviour that only appears at runtime. Adding the suite would turn a twelve-second floor into a minute spent re-measuring a known result.

**It runs after a successful construction, in the same pass.** A construction that failed records the clean run as `skipped` naming the layer that fell, which is what D-031 requires the record to be able to say, and D-028's ordering already forbids spending on a candidate that does not exist.

Shadow mode per D-028: it records and blocks nothing. Making it a gate is a later decision that costs nothing structural.

### D-035 — The reader reads the test diff, and says where it is looking

The advisory layer D-026 declared and D-027 kept advisory is built. Written in four lanes over 2026-08-15 and then run end to end on a real candidate on the Windows host, which is what this decision is written from.

**A finding is a row that says where it points and which question it answers.** `verification_findings` carries `locations`, a list of `{ path, side, start_line, end_line }`, and `subject`, exactly `test_diff` or `source_context`. A single path and line pair was rejected: a deleted assertion exists only on the **base** side of the diff, and the sharpest finding in the D-026 bake-off spanned two files. `subject` was rejected as inferable from `out_of_change`, because a defect inside changed source is in-change and still outside the declared subject, and shadow mode measures whether the reader answered the question it was asked. This is not the fingerprint D-031 rejects: that decision refuses matching a finding's *identity* across runs, and nothing here does.

**The runner knows nothing about the conductor.** `src/reader.ts` takes a candidate worktree, the base commit construction recorded, and the plan's rejected findings, and returns findings. It opens no verification run and does not talk to the hub. `src/conductor.ts` decides when it runs and records what it said, after the clean run, in the same guarded style D-034 gave that layer. A runner that already knew about the conductor could not be tested without one.

**Which paths are tests is the project's own statement.** `.laneward/project.json` gains `reader.test_paths`, beside the `checks` and `clean_run` D-029 and D-034 put there. Guessing was rejected: the test diff is the declared subject per D-026, and a layer that guesses its own subject measures nothing. A repository that declares none has its reader `skipped` naming the missing declaration, which is not a failure of the candidate.

**A report that cannot be read is a failed run, not a quiet one.** `no_findings` is a claim only a parsed, empty report may make. "The reader saw nothing" and "we do not know what the reader saw" are the difference shadow mode exists to measure, and collapsing them would make the measurement meaningless in exactly the case that matters. The runner's statuses are the `verification_runs` vocabulary already, so the conductor records what it returned rather than translating it.

**The binary comes from the caller, not from the environment.** `runReader` reads `CODEX_BIN` only as a fallback. It was written the other way first, and the conductor's drain tests then believed they were driving a fixture while spending real model calls on a two-line diff, silently and for 254 seconds a run. A layer whose executable is chosen by ambient state cannot be pointed at a fixture by the caller that owns it. The tests assert the fixture actually ran, not merely that a status came back, which is the assertion that would have caught it.

**Delivery is one class, and the toast is opt-in.** `findings_to_adjudicate`, scoped to the plan revision, which is why `notifications.subject_kind` gains `plan_revision`. Its urgency is `normal`: a `critical` toast would make an advisory finding a gate by tone, which D-027 forbids in substance. `GET /pending` answers with open findings beside the approvals rather than among them, because an approval blocks a lane and a finding does not. The dashboard shows the reader run and the findings on the revision, so a reader that found nothing and a reader that never ran do not look alike. The record is always visible; only the interruption is configured, and `LANEWARD_NOTIFY` keeps its default of the two classes that block work.

**What the first real candidate showed.** One lane, rendering a finding's locations as `path:start-end (side)`, whose tests assert the delivered page source rather than the rendered behaviour. That weakness was left in deliberately. The reader named it, on the right side of the diff, under the right subject:

> The new assertions only match JavaScript source fragments in the HTML template; they do not seed a finding or assert the rendered location text. A broken runtime path or incorrect output formatting can still pass this test.

One candidate is one measurement and not a bake-off, and no claim about the layer's hit rate is made here. What it does establish is that the layer produces a finding a person can act on, in the place it happened, and that D-028's ordering holds in practice: on the same plan's first revision the clean run failed and the reader was recorded `skipped` naming `clean_run`, unspent.

**Three environment faults the suite could not have found**, all from that same run, recorded because each will recur. `clean_run.shell.win32` is `["bash", "-lc"]`, and bare `bash` resolves to WSL on this host, so the clean run judged the candidate under a different operating system than the hub runs on and every expectation failed on a missing `notify-send`. That is settled now rather than left to an operator's `PATH`: the layer resolves the declared interpreter to an absolute path before spawning and records it on the result, and on Windows it refuses one under `System32` as `unrunnable` naming what it refused, because a clean run that observes the candidate on an operating system the host is not has measured nothing. `LANEWARD_CLEAN_RUN_SHELL`, absolute, is the escape hatch and is checked first. The containment is decided with `win32.relative` and the platform and resolver are injected, so the rule is asserted on both platforms per D-022 rather than only where the test happens to run. The hub's own database had never been migrated after a schema-changing merge, because `db:migrate` had only been run against the test and per-lane databases. And the hub process itself predated the merge it was serving, so it rejected a finding for a `subject` its code did not know about: a long-lived development process is its own stale-code hazard.

Evidence: the reader layer shipped in four steps; the plan that drove them was retired once it was finished.

## Runtime and completion

### D-012 — Runtime effects receive a separate approval

Installations, service restarts, database migrations, writes to real data, and other external effects require a final explicit approval even when the implementation plan was already approved.

### D-013 — Done means installed and verified

A task is complete only when it is installed in the intended environment and its real behavior is verified.

Typical verification:

- web application: reachable URL, health check, and essential user flow;
- Linux service: active service, healthy logs, and a real smoke command;
- automation: controlled real example and expected side effect;
- CLI: installed executable and a real command from a clean directory.

## Operation

### D-013a — A closed plan leaves no orphaned worktree

Lane worktrees, branches, and lane databases are removed once the plan reaches `done` and the lane commits are integrated. This states the end condition, not the trigger: D-025 supersedes the original wording here, which said removal happens when the plan reaches `done`. Nothing removes them automatically. Teardown is one explicit operator command, because an automatic removal would delete a worktree at a moment nobody is watching.

Evidence and logs outlive the worktree. Cleanup must never remove the record of what happened inside it.

### D-025 — Teardown is one explicit command that refuses a dirty worktree

D-013a says what is removed. This says what removes it, and when.

Teardown removes the three things lane creation made: the worktree, the `lane/<lane_id>` branch, and the lane database `scripts/new-lane.ts` provisioned. The database is included because the hub created it; leaving it behind is why finished lanes accumulate in Postgres today.

It runs from one explicit operator command, the counterpart of `scripts/new-lane.ts`. Nothing tears a lane down automatically when its plan reaches `done`. Automatic removal would delete a worktree at a moment nobody is watching, and the deletion is not reversible.

The command refuses a worktree with uncommitted changes or commits that are not integrated, reports what it found, and removes nothing. A clean worktree is removed without asking. All of the evidence-loss risk lives in the dirty case, so that is the only case that stops.

Evidence and logs outlive teardown, per D-013a. The lane database name is not stored on the lane row; it is derived as `<base>_lane_<lane_id>` and can be re-derived from the lane's own `.env`.

### D-014 — Approved lanes continue after Claude exits

Laneward and its workers continue approved work independently. Completed Codex work stops at `ready_for_review`; no commit is created until Claude returns, reviews, and validates it.

### D-015 — Laneward starts automatically

The API, dashboard, worker supervision, and notification integration start without an interactive session and survive a reboot.

On Linux this is systemd user services. On Windows it is the platform's own equivalent, chosen when that layer is implemented. The requirement is the behavior, not the mechanism; see D-022.

After a crash or reboot, stranded work is inspected before it is resumed.

### D-016 — Dashboard and desktop notifications are complementary

The dashboard is the detailed pull-based view. Linux desktop notifications are used only for attention-worthy events.

## Security

### D-017 — Network access is denied by default for Codex

A plan must explicitly justify network access. Approval applies only to the lane and purpose described in the plan.

Secret values must not appear in prompts, logs, reports, or agent output.

Current state (2026-08-15): this is a convention, not a control. `scripts/new-lane.ts` copies the repository `.env` into the lane worktree, so a worker can read real secret values. The one exception is `DATABASE_URL`, which is rewritten to a per-lane database. Isolation of the rest is deferred by decision and recorded as a known limitation in the README.

## Project records

### D-018 — Project records live inside the project directory

Obsidian is not used for operational or decision state.

Stable configuration and decisions may be committed. Volatile runtime state remains local and ignored by Git.

## Platform

### D-022 — Windows and Linux are both first-class

Laneward targets Windows and Linux. A change is not complete until it works on both.

macOS is out of scope. No macOS path is designed, documented, or verified, and a macOS gap is not a defect.

Every layer needs an answer on both platforms, including the persistence layer, because D-014 and D-015 are not conditional on the operating system. Details are in [10-platform-support.md](10-platform-support.md).

### D-037 — On Windows the database is the same container, published on 127.0.0.1

The Podman machine runs the same `postgres:16-alpine` the Quadlet defines on Linux, and the port is published on `127.0.0.1`. One container definition holds for both platforms.

A native Windows Postgres service was considered and rejected: it removes the virtualization dependency, but it buys that with a second installation path, a second set of operator instructions, and a database whose version drifts from the one Linux runs. Docker Desktop was rejected for its licensing and weight when Podman already runs here.

The cost is accepted and named: Windows support depends on a running Podman machine, and that machine does not survive a reboot on its own. A conductor that cannot reach the database must say so rather than fail obscurely.

CP-4's symptom is the reason this needed writing down at all: the development host's `.env` points at the Podman machine's WSL address rather than `127.0.0.1`, so the documented quickstart does not describe what a Windows operator actually has.

Decided 2026-08-15.

### D-038 — On Windows the conductor is a Scheduled Task at logon

Supervision is a Scheduled Task that starts `conductor.ts --loop` at user logon, not a Windows service and not the systemd units under WSL.

The choice is narrower than it looks, because one fact removes the usual reason to prefer a service. Windows has no POSIX signal delivery, so neither a service wrapper nor a task can hand the conductor a catchable `SIGTERM` (CP-3). Both stop it by terminating the process, both leave lanes `running` with no worker behind them, and both therefore depend on `scripts/reset-stranded.ts` for recovery exactly as a crash or reboot does. The clean shutdown that makes `laneward-conductor.service` pleasant on Linux is not available to either Windows option, so it cannot be the tiebreaker.

What is left is dependencies. A Scheduled Task is built into the platform. NSSM and WinSW are third-party binaries that must be obtained, installed and kept current to run a developer tool on one machine.

Running without a logged-in user is not a requirement here: the conductor spawns `codex`, which reads its credentials from the operator's profile, so a session-less service would need those provisioned separately — which is more work for a capability nobody asked for.

This is revisited if Laneward is ever deployed to a Windows host that is not a developer's desktop.

Decided 2026-08-15.

### D-023 — The Codex Git boundary is enforced by Laneward, not by the sandbox

The control that prevents a worker from mutating Git state belongs to Laneward and the worker's environment: a restricted `git` on the worker's `PATH` that permits read-only subcommands and rejects mutating ones, plus repository credentials kept out of the worker environment.

Sandbox behavior may reinforce this, but it must never be the thing the boundary relies on.

Measured on 2026-08-07, after repairing a Codex sandbox failure on the Windows host: the `workspace-write` sandbox does already deny every Git mutation from a lane worktree. A linked worktree's object store sits outside the writable workspace, so Git cannot write its lock file and every mutating command fails. Read commands still work.

That result does not retire this decision, for two reasons. The denial is a property of the sandbox rather than of Git, and the same day showed that sandbox being entirely absent for hours on this host. A boundary that disappears when a sandbox misconfigures is not a boundary.

What the measurement does change is the wrapper's role: defense in depth over a working confinement, rather than the only control. Keeping credentials out of the worker environment remains unmet and is the real gap, since credential configuration was readable during the probe.

Evidence: [../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md](../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md).

## Optional systems

### D-019 — GPT Pro handoff is disabled

The user does not have an active GPT Pro subscription. The skill may remain stored, but it is not part of routing, planning, validation, or fallback behavior.

### D-020 — OMP is removed

OMP is not part of the architecture or implementation roadmap. It may only return through a future, separately approved measurement exercise.

### D-021 — ACOS is deferred and incomplete

ACOS is not production-ready and must not block Laneward v1.

After Laneward proves stable, ACOS will itself be refactored through Laneward and specialized as a release-candidate audit system.

### D-024 — Notification delivery is recorded separately

A notification row is written when the condition is detected, not when the notification is delivered. `sent_at` therefore means the condition was seen. `delivered_at` records that the platform command exited 0.

A failed delivery is recorded and deliberately not retried. The poll runs every second, so a permanently broken delivery path would otherwise spawn a process per second, and no observed case justifies inventing a backoff policy yet. The alert itself may be lost, which is acceptable because pending work is reloaded from Laneward regardless.
