# Issue #12, verified against the tree, and the plan that follows

Issue #12 is an external audit
captured at commit `ee938e1` on 2026-08-09. This note re-checks every finding
against `b3f9595` on 2026-08-15, six days and one verification layer later, and
turns what survives into an ordered plan.

The audit itself says findings may have changed since the snapshot. They have,
in both directions: some are closed, one is now more wrong than when it was
written, and one whole report is scored against a target this project rejected.

## Still true, with the evidence

| Finding | Evidence at `b3f9595` |
|---|---|
| P1a Active architecture holds stale current-state prose | `docs/architecture/workflow-v1/README.md:7` still reads `Implementation status: not started`; `01-decisions.md:57` still reads `nothing enforces this`; the retired `new-lane.sh`, `check-evidence.sh` and `codex-round.sh` paths are still referenced in seven files |
| P2a Manifest filename differs from the documents | `.laneward/project.yml` in four architecture documents and one brief, while the runtime reads `.laneward/project.json` |
| P2b README API and configuration surface incomplete | `GET /lanes` is absent from the route table; `LANEWARD_CHECK_TIMEOUT_MS`, `LANE_WORKTREE_ROOT` and `LANE_PLAN_REVISION_ID` appear nowhere in the file |
| CP-1 No Windows installation path | `install.sh` only; no `install.ps1`, service definition or scheduled task |
| CP-2 Worker supervision is not a service | `systemd/laneward.service:9` runs `bun run start`, which serves the API and the notifier and never starts the conductor |
| CP-3 Windows shutdown recovery | `tests/conductor.signals.test.ts` still carries `test.skipIf(process.platform === "win32")` |
| CP-4 Windows database quickstart | `.env` on this host points at the Podman machine address rather than `127.0.0.1`, exactly as the audit describes |
| CP-5 State and log paths diverge | `src/conductor.ts:661` falls back to `LOCALAPPDATA` on `win32`; `src/dashboard-data.ts:13` falls back to `HOME/.local/state` with no Windows branch. The symptom is a running lane whose log the dashboard cannot find |
| CP-6 No continuous verification | there is no `.github` directory at all |
| CP-7 Linux desktop delivery unproven | the notifier still invokes `notify-send` directly and nothing installs or checks for it |
| CP-8 XDG mismatch | `install.sh` honours `XDG_*`, while `systemd/laneward.service` and `quadlet/laneward-db.container` hardcode `%h/...` |
| CP-9 Windows operator documentation | absent |
| CP-10 `os.devNull` | `src/conductor.ts:97` hardcodes `"NUL"` and `"/dev/null"` behind a platform ternary |

## Closed since the audit

**The verification half of P2b.** The README documented no candidate
construction and no verification layers when the audit ran, and the word
"reader" did not appear in it. As of `b1fd21f` it carries candidate
construction, the three layers and their ordering, the finding lifecycle, the
routes that expose them and the notification class. The API and configuration
surface listed above is what remains, and it remains because the audit lane's
brief pointed it at capability claims rather than at the route table and the
environment variables. That gap is the brief's, not the worker's.

## Now wrong

**"Linux is unmeasured"**, in `05-safety-and-git-policy.md:44` and
`10-platform-support.md:102`. Measured on 2026-08-15: the suite runs under WSL
at 275 pass, 0 fail, including `tests/git-guard.test.ts` and the SIGINT test
Windows skips ([notes](2026-08-15-linux-suite-run.md)). The documents are now
behind reality rather than ahead of it, which is the same defect P1a describes
pointing the other way.

**CP-6's numbers.** "A 116-test snapshot from 7 August" against "193 tests on
Windows" is now 275 and 274. The substance holds: a manual run is not continuous
verification. Only the arithmetic is dead.

## To be closed as invalid

**The second report's scoring premise.** It scores "Windows/macOS/Linux
operational readiness" at 31/100 and calls the end-to-end claim invalid, while
D-022 excludes macOS explicitly and states that a macOS gap is not a defect. The
issue notes the conflict and then carries the score anyway. A score against a
target the project has rejected is not a measurement of this project, and it
should be retired rather than tracked.

## Not a finding, a decision left open

**P1b, ownership serialization.** `05-safety-and-git-policy.md:52` permits
overlapping owned paths when the plan explicitly serializes the lanes.
`POST /lanes` rejects overlap with every non-terminal lane, including lanes that
could never run at once because of their dependencies. The code is the safer of
the two. What is wrong is that both are written down as the rule.

## Plan

### Stage 0: make the issue describe the repository, no code

Post the verification above as a comment. Retire the second report's macOS
scoring against D-022. Correct CP-6's numbers to the current measurement. The
issue stops being an audit report and becomes a tracking list.

### Stage 1: documentation truth, one lane

The three confirmed documentation findings, together because they share a root
cause: current-state prose edited additively until new truth sits beside old.

- P1a: the six stale statements, two of which are now actively false.
- P2a: `project.yml` to `project.json` in five files.
- P2b: the `GET /lanes` row, the undocumented environment variables, and making
  "resume" say plainly that a new `codex exec` receives the original brief plus
  the decision rather than a restored session.

Carry a convention out of it: a current-state line states its date, so the next
reader can tell a measurement from a memory.

### Stage 2: settle the two open decisions, no code

- Ownership serialization: the policy follows the code, or the code follows the
  policy. One of them, written as a decision.
- macOS scope: D-022 already answers it; the audit's contradiction is closed
  where decisions live.

### Stage 3: CP-5, the one real code defect

A single shared resolver for the state directory. It is the only platform
finding with a symptom a user meets: a running lane whose log the dashboard
cannot show.

### Stage 4: CP-6, a Windows and Linux matrix in CI

`.github/workflows` with a Postgres service, both platforms. This turns
2026-08-15's single Linux run into continuous verification and protects stages 1
through 3 from regressing. Everything after this stage is cheaper for having it.

### Stage 5 and beyond: the expensive half, in the audit's own order

CP-2 conductor supervision, which is what "approved lanes continue after Claude
exits" would require; then CP-1, CP-4 and CP-9, the Windows installation story;
then CP-7 and CP-8, Linux delivery and XDG consistency; then CP-10 hardening.
These are what meeting D-014 and D-015 actually costs, and each deserves its own
plan rather than a line in this one.

That plan was the stage 5 plan, retired once its stages shipped. It
reorders the audit's list around one fact: `conductor.ts` is a one-shot `drain`
that exits, so CP-2 is not a packaging gap but an unimplemented D-014, on both
platforms. Nothing else in Stage 5 is worth building before the conductor has a
supervised loop, because everything else is a way of starting it.

## Recommended order

Stages 0, 1 and 2 now: all of it is documentation and decisions, all of it is
verified, none of it can regress the suite. Then 3 and 4. Stage 5 gets a plan of
its own, not a bullet under this one.

## What was executed, 2026-08-15

**Stage 1, done.** P1a: the workflow-v1 README now carries a dated
implementation status and the convention that a `Current state` line states its
date; D-003, D-008 and D-017's current-state lines are re-dated and corrected;
`02`, `09` and `10` name the TypeScript scripts. The two "Linux is unmeasured"
statements in `05` and `10` are replaced with what the 2026-08-15 WSL run did
establish and what it did not. P2a: `project.yml` is `project.json` in four
architecture documents, and `04`'s YAML sketch is the JSON the runtime actually
parses, with a current-state line saying only `version` and `checks.lane` are
read. P2b: `GET /lanes` and `POST /plan-revisions/:id/approvals` added to the
route tables, `LANEWARD_CHECK_TIMEOUT_MS`, `LANE_WORKTREE_ROOT` and
`LANE_PLAN_REVISION_ID` added to the configuration table, and "resume" now says
plainly that a new `codex exec` receives the original brief plus the decision.

**Stage 2, done.** Ownership serialization is settled as D-036: the code's
stricter rule wins and `05`'s permission is withdrawn. macOS needed nothing:
D-022 already says it, and the correction belongs in the issue, not in a new
decision.

**Stage 3, done.** `src/paths.ts` holds `stateHome` and `defaultLogDir`; both
`src/conductor.ts` and `src/dashboard-data.ts` call it. Environment and platform
are injected, so `tests/paths.test.ts` asserts the Windows branch from Linux too.

**Stage 0, posted.** [issue #12 comment](issue #12#issuecomment-5302424208),
carrying the verification above, D-036, the retirement of the macOS score, and
the stage status. The issue is a tracking list now rather than an audit report.

**Stage 4, written, unrun.** `.github/workflows/ci.yml` runs the suite on
`ubuntu-latest` and `windows-latest`. Linux uses a `postgres:16` service
container; Windows uses the PostgreSQL that ships with the runner image, matched
by service-name prefix because its major version moves with the image. Both point
`DATABASE_URL` at `laneward_test`, which is what `src/db.ts` requires under
`NODE_ENV=test`. Typecheck runs on Linux only.

What is verified: the YAML parses, `bun run typecheck` passes locally, and the
lockfile `--frozen-lockfile` needs exists. What is not: the workflow has never
executed. A GitHub Actions workflow cannot be run from this machine, so its first
real evidence is the first push. The Windows leg is the one to watch: the
PostgreSQL service name and the superuser password are properties of the runner
image, not of this repository.

### The suite, and one thing found on the way

Measured on this host: 272 pass, 1 skip, 7 fail across 280 tests. All 7 are in
`tests/conductor.drain.test.ts` and fail identically at `b3f9595` with no local
changes, so nothing here regressed.

Their cause is worth recording before Stage 4. `tests/fixtures/fake-candidate.ts`
declares `shell: { win32: ["bash", "-lc"] }`, and on this machine bare `bash` is
`C:\WINDOWS\System32\bash.exe`: WSL. The clean-run layer refuses it, correctly
and by design, because a candidate observed under Linux while the host is Windows
has measured nothing. On GitHub `windows-latest` bare `bash` is Git Bash, so the
fixture is right in CI and wrong only here.

Setting `LANEWARD_CLEAN_RUN_SHELL` to a Windows-native bash made those 7 pass and
broke 10 others instead: the clean-run tests assert the interpreter *resolution*
behaviour and never unset the variable, so the documented escape hatch silently
changed what they measured. There was no environment in which the suite was
green, which would have made Stage 4's first red run unreadable.

Fixed. `tests/lane-checks.test.ts` clears the variable in `beforeAll` and
restores it in `afterAll`; the two tests that want it set it themselves. With the
override set the suite is **279 pass, 1 skip, 0 fail**, the first green run on
this host. Without it, the only failures are the seven the host's WSL `bash`
causes, the shape CI will run in, where bare `bash` is Git Bash and they do not
occur.

The general lesson, since it will recur: an operator escape hatch that a resolver
checks first is exactly the kind of variable a test must control rather than
inherit. Nothing here was wrong with the resolver; the tests were measuring the
operator's environment and reporting it as the code's behaviour.
