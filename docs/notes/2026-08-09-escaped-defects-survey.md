# Escaped defects: what has actually got past Claude so far

Date: 2026-08-09. Research for issue #3,
under map #2 (issue #2). Read-only survey of
this repository's own written record; no source file was touched and no test was
run to produce it.

Sources: every file in `docs/notes/`, the `Status:` sections of
`docs/architecture/workflow-v1/09-implementation-roadmap.md`, the decision log
`01-decisions.md`, and the commit messages of the fixes those documents point at.

## Scope of "escaped"

A defect counts here if it was found **after** something had already accepted the
work: a passing test suite, a completed review, a merged lane, or a closed phase.
Deliberate deferrals (secret isolation, worktree ownership transfer, the unbuilt
plan statuses) are not defects and are excluded. Defects found *inside* a lane's
own correction loop, before anything accepted it, are also excluded; the loop
working as designed is not an escape.

Thirty entries qualify.

## 1. The inventory

Each entry: what escaped, what had already accepted it, and the sentence that
records it.

### Phase 2: the Git boundary

**E-01. The guard's real-git fallback resolved itself, and the production path
was dead.** Accepted by: 18 of 18 targeted guard tests, green throughout.
`09-implementation-roadmap.md`: "the guard's `resolveRealGit` fallback derived
the shim directory from `dirname(import.meta.path)`, which is `scripts/`, but the
shim lives in `scripts/git-shim/`. The shim survived the PATH filter and the
guard resolved itself. […] The test suite stayed green throughout because its
helper always injected `LANEWARD_REAL_GIT`, so tests resolved git a different way
than production did."

**E-02. The POSIX shim was committed non-executable.** Accepted by: the whole
Windows measurement, where the `.cmd` shim is the one that runs.
`09-implementation-roadmap.md`: "the POSIX shim was committed as mode 100644,
which fails exec with permission denied on Linux". Commit `560e9e6`: "Neither
defect is visible on Windows".

**E-03. The POSIX shim would have carried a CRLF shebang terminator.** Same
acceptance, same commit. Roadmap: "would have picked up a CRLF shebang terminator
from this repository's `core.autocrlf=true`; a `.gitattributes` entry now pins
that file to LF with mode 100755".

**E-04. The allowlist refused four harmless read-only commands.** Accepted by:
Phase 2 closing on Windows *and* Linux with 18 of 18 guard tests. Roadmap: "The
guard's allowlist now admits `git --version`, `rev-list`, `worktree list`, and
`stash list`." Commit `4b71c15`: "a worker hitting one got a confusing REFUSED
for a plain read."

### Phase 2b: the cross-platform rewrite

**E-05. `new URL(path, import.meta.url).pathname` yields `/C:/...` on Windows, in
six places.** Accepted by: the rewrite's own test suite, and it survived the very
rewrite meant to remove this class of problem. Roadmap: "It appeared in six places
including `src/conductor.ts`'s evidence-script constant, where it broke the
production path while the test still passed, because the test resolved the same
file a different way."

**E-06. `tests/dashboard.logs.test.ts` asserted a POSIX separator for a value
that is only ever a filesystem path.** Accepted by: every prior suite run, but
see E-08 for why that acceptance was worthless. Roadmap: "The test's hardcoded
`/var/logs/gig-radar.log` expectation was the defect, not the code".

**E-07. Ctrl-C on Windows leaves a lane stuck `running`.** Accepted by: a suite
that had never executed this file on Windows. Roadmap: "on Windows, Ctrl-C during
a conductor run does not hand the interrupted lane back to HUB as `pending`; the
lane is left `running` and needs manual cleanup before the next run. HUB has no
staleness detection for a lane orphaned this way."

**E-08. Every test number recorded before 2026-08-07 was fiction.** Accepted by:
the roadmap itself, repeatedly, as measured evidence. Roadmap: "Every measurement
in this document before 2026-08-07 was taken with `DATABASE_URL` unset, which
aborted 16 files at import, so most of the suite had never actually run." This is
the most consequential entry in the survey: for two phases, "the suite passes" was
a statement about 2 of 117 tests.

### Phase 3: automatic lane checks

**E-09. The timeout test read a pid file the child never lived to write.**
Accepted by: the lane's own delivery and its recorded verdict. Roadmap: "The
timeout test set `LANEWARD_CHECK_TIMEOUT_MS` to 30ms and then read a pid file the
child never lived long enough to write".

**E-10. Two conflicting assertions in `tests/conductor.lane.test.ts`.** Same
acceptance. Roadmap: "a non-escalating lane now asserts the absence of an
`APPROVAL_REQUEST` row rather than the absence of any `/messages` request, because
a worktree with no manifest legitimately posts one `not_configured` evidence
message."

**E-11. A lane driving Laneward itself truncated the live hub database
mid-flight.** Accepted by: everything up to that point; `new-lane.ts` had been
exercised end to end and declared verified. Roadmap: "the suite truncates `lanes`,
`messages`, and `approvals`, which deleted the running lane's own row mid-flight;
the conductor's escalation POST then failed with HTTP 500 against a lane that no
longer existed, and a leftover test lane was picked up as dispatchable and
dispatched three times."

**E-12. Bun will not let a `.env` file override a variable already in the
environment.** Accepted by: the per-lane-database fix that was itself written to
close E-11. Roadmap: "Bun does not let a `.env` file override a variable already
present in the environment, so the first attempt migrated the hub's database
instead of the lane's and left the lane's empty, 74 tests failing."

### Phase 4: the neura-system pilot

**E-13. An escalating worker recorded no evidence at all.** Accepted by: the
whole of Phase 3, closed on four live observations, all of which used the
fake-codex fixture. Pilot note: "`runLane` matched the escalation marker before it
ran the lane checks, so a worker that escalates, which on this host is every
honest worker that needs a container, produced an `APPROVAL_REQUEST` and nothing
else."

**E-14. The lane opener's own `bun install` failed the worker.** Accepted by:
`new-lane.ts`'s end-to-end verification, which used a target repository that
happened to have a lockfile. Pilot note: "The evidence check scores every dirty
path against `owned_paths`, so the first run was failed for a file the worker
never touched, before its work was looked at."

**E-15. A lane could be registered against a worktree that does not exist.**
Accepted by: `POST /lanes` and its tests. Pilot note: "`POST /lanes` accepted it,
and the problem only surfaced three Codex dispatches later, as a lane that failed
on `The system cannot find the file specified` and looked like its own work was at
fault."

**E-16. Per-lane database isolation silently did not exist for a split `.env`.**
Accepted by: the per-lane-database lane, verified live. Pilot note:
"`provisionLaneDatabase` matches `^DATABASE_URL=` in the copied `.env`.
`neura-system` keeps `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME` and
`DATABASE_USER` separately, so no lane database was created and no isolation
existed."

**E-17. `await expect(<postgres query>).rejects.toThrow()` never settles.**
Accepted by: the worker's own delivery of six tests. Pilot note: "Five of the six
tests used that shape, so `bun test` hung and burned the checker's entire 600
second timeout, recorded as `overall: "unrunnable"`. […] That is one hung check
costing ten minutes of wall clock".

**E-18. A `jsonb` value written as a stringified string round trips as a
string.** Same acceptance. Pilot note: "`${JSON.stringify(value)}::jsonb` stores a
jsonb string scalar, not an object."

**E-19. `POST /approvals/:id` answered 500 for a `resolved_by` outside the check
constraint.** Accepted by: the approvals route and its tests, and it survived the
whole pilot. Pilot note: "Unchanged from before the pilot, and still worth a 400."

**E-20. `resolved_by` records who typed a decision, not who verified it.** Pilot
note: "nothing in the record distinguishes a decision the user approved from one
Claude reached on its own." A specification gap that shipped, not a runtime fault.

**E-21. There was no way to correct a lane record.** Pilot note: "the lane had to
be re-registered under a new id […] because the API has no update or delete route".

### Phase 6: the bridge and the hooks

**E-22. `WorktreeCreate` cannot be a gate, and `bridge gate` was wired to it.**
Accepted by: the Phase 6 merge. 2026-08-08 note: "The event does not vet worktree
creation, it replaces it […] `bridge gate` prints nothing when it allows, so every
worktree Claude Code tried to create died."

**E-23. `PreToolUse` failing closed with the hub down denied every edit,
including the ones needed to unwire the hook.** Same note: "the gate fails closed,
the hub was down, and the result was that every `Edit`, `Write` and `Bash` in the
main checkout was denied, including the ones needed to unwire the hook. Recovery
had to be typed by hand into the session shell with `!`."

**E-24. `lane_id` was open to path traversal.** Accepted by: every phase up to
Phase 6. Same note: "It becomes a worktree directory, a branch and a log file
name, and the only check was that it was not empty."

**E-25. `codex-round.ts` spawned `codex` with Bun's default stdio, so the brief
never arrived.** Accepted by: the CODEX_BIN seam and its fixture-based tests.
Commit `683b4bb`: "codex printed 'No prompt provided via stdin' and exited, and the
conductor scored three attempts of that as a failed lane."

### Phase 7: the notifier

**E-26. Two of the five notification classes can never fire.** Accepted by: 185
passing tests, 1 skip, 0 failures, host-verified from the worktree, with
`git status --porcelain -uall` clean of unowned files. 2026-08-08 note:
"`runtime_verification_required` and `plan_complete` are declared in
`notificationClassNames`, accepted by `LANEWARD_NOTIFY`, and allowed by the
`notifications` CHECK constraint, but `candidates()` emits only
`approval_required`, `lane_failed` and `plan_ready_for_review`."

**E-27. The Windows toast interpolates free text into an evaluated PowerShell
string.** Same acceptance. Same note: "`windowsCommand` builds the script with
`JSON.stringify(title)`, which yields a PowerShell **double-quoted** string, where
`$(...)` and backticks are evaluated. Plan titles are free text, so a title
containing `$(...)` runs as code on the host. The `-EncodedCommand` wrapper does
not help: it encodes the already-composed script."

**E-28. `powershell.exe` is not on PATH for a process started from git-bash.**
Accepted by: the merge, *after* E-26 and E-27 had been found and fixed by a diff
review. Same note: "the merged feature failed the first time it ran for real, and
the failure was not in the diff anyone reviewed. […] delivery died with
`Executable not found in $PATH: "powershell.exe"`."

**E-29. Resolving an approval is not a close-out.** Same note: "`/lanes/dispatchable`
returns a `waiting_approval` lane whose approvals are all resolved, so a running
conductor would have redispatched the merged lane."

**E-30. The D-024 delegation came back with a deleted assertion.** Accepted by:
a green suite: the delegated change passed. 2026-08-09 note: "Three things in
what came back needed fixing, none of which a passing suite would have caught:
[…] in the 'notifies once' test it **replaced** the row-count assertion with the
new `delivered_at` one, dropping the thing that proved the ledger deduplicates
[…] the throwing delivery path had no `delivered_at` assertion."

## 2. Diff-readable, or only findable by running?

Judgement per entry. **DIFF** means a competent independent reviewer, given the
diff and the brief but not the machine, would plausibly have raised it. **RUN**
means the evidence for the defect does not exist anywhere in the diff; it lives
in the host, the platform, a library's runtime semantics, or the interaction of
two components neither of which is wrong alone. **DIFF-hard** means the finding is
in the diff, but only for a reviewer who also holds a specific piece of platform
or repository knowledge.

| # | Defect | Verdict | Why |
|---|---|---|---|
| E-01 | guard resolves itself | **DIFF-hard** | The mismatch is visible: the shim's path is in the same diff as the fallback that derives it. Requires the reviewer to notice the test helper injects a variable production never sets. |
| E-02 | shim mode 100644 | **DIFF** | The mode is literally in the diff header. |
| E-03 | CRLF shebang | **DIFF-hard** | Needs knowledge of this repo's `core.autocrlf=true` and the absent `.gitattributes`. Repo context, not runtime. |
| E-04 | allowlist too narrow | **DIFF** | Pure spec-vs-code: the brief says "read-only subcommands", the list omits four. |
| E-05 | `new URL(...).pathname` | **DIFF-hard** | Recognizable as a pattern, but only to a reviewer who knows the Windows behavior. |
| E-06 | POSIX separator expectation | **RUN** | Nothing marks the expectation as wrong until a Windows machine runs it. |
| E-07 | SIGINT on Windows | **RUN** | A platform capability. No diff contains it. |
| E-08 | the suite had never run | **RUN** | The defect is the absence of execution. Unreviewable by construction. |
| E-09 | 30ms timeout / pid file race | **DIFF-hard** | A sharp reviewer may spot that 30ms cannot cover process spawn. Most would not. |
| E-10 | conflicting assertions | **DIFF** | Both assertions are in the same file; the contradiction is readable. |
| E-11 | lane truncated the live database | **RUN** | An emergent property of `.env` copying plus the suite's truncation plus the lane's target being Laneward itself. No single diff shows it. |
| E-12 | `.env` does not override the parent | **RUN** | A Bun runtime semantic. The diff looks correct. |
| E-13 | escalation short-circuits checks | **DIFF-hard** | The ordering is visible in the control flow. Whether it matters depends on knowing escalation is the *normal* path on this host, which is host knowledge. |
| E-14 | opener's lockfile fails the worker | **RUN** | Two correct components interacting. Only a repo with no committed lockfile exposes it. |
| E-15 | worktree path never validated | **DIFF** | Missing input validation at a trust boundary. Textbook review finding. |
| E-16 | single-`DATABASE_URL` assumption | **DIFF** | A single-format assumption that fails *silently* rather than erroring, visible and objectionable in the diff. |
| E-17 | `expect().rejects` never settles | **RUN** | The pilot note is explicit: "invisible without running the suite". Depends on the `postgres` library's lazy query object. |
| E-18 | `JSON.stringify(v)::jsonb` | **DIFF** | Recorded alongside E-17 as also invisible without running; **that classification is wrong**. `${JSON.stringify(value)}::jsonb` versus `sql.json(value)` is a readable SQL defect for any reviewer who knows jsonb. |
| E-19 | 500 instead of 400 | **DIFF** | Missing validation ahead of a database constraint. |
| E-20 | `resolved_by` conflates two roles | **DIFF** | A spec-vs-code review finding, catchable against the decision log. |
| E-21 | no way to correct a lane | **DIFF** | Missing route, readable against the API surface. |
| E-22 | `WorktreeCreate` is not a gate | **RUN** | The event's real contract is in Claude Code's documentation, not in the diff. Catchable only by a reviewer holding that doc. |
| E-23 | fail-closed gate locks the session | **DIFF** | The single highest-value review question, "what happens when the hub is down?", answers this from the diff alone. |
| E-24 | `lane_id` path traversal | **DIFF** | Textbook. Unvalidated input becomes a filesystem path. |
| E-25 | stdio defaults swallow the brief | **DIFF-hard** | Requires knowing Bun's `spawn` stdio defaults. |
| E-26 | unreachable notification classes | **DIFF** | The declared set and the emitted set are both in the same diff, a few dozen lines apart. |
| E-27 | PowerShell interpolation | **DIFF** | Injection into an evaluated string. `-EncodedCommand` is a decoy that a weak reviewer accepts and a good one sees through. |
| E-28 | `powershell.exe` not on PATH | **RUN** | Environmental. The note says it outright: "the failure was not in the diff anyone reviewed." |
| E-29 | resolved approval still dispatchable | **RUN** | A behavioral property of a live query against live state. |
| E-30 | deleted assertion in a delegated test | **DIFF** | **Only** a diff read finds this. A deleted assertion is invisible to every possible test run, by definition. |

Tally: 13 DIFF, 7 DIFF-hard, 10 RUN.

## 3. What this actually means

### The headline is not "review catches nothing", and it is not "review catches everything"

Counted by entry, two thirds of what escaped was in principle readable from the
diff. That is a real argument for a review layer and it should not be waved away.

But counting entries is the wrong weighting, and the record says so. Sort the
thirty by what they actually cost:

- **Live production data destroyed**: E-11, E-12, and the recurrence recorded in
  commit `dbdd9c3` ("It has happened repeatedly"). All RUN.
- **Two phases closed on numbers that were fiction**: E-08. RUN.
- **Ten minutes of wall clock burned on one hung check**: E-17. RUN.
- **Three wasted Codex dispatches, twice**: E-15 (DIFF) and E-25 (DIFF-hard).
- **Worktree creation dead across the whole tool**: E-22. RUN.
- **A session locked so hard that recovery had to be typed by hand**: E-23. DIFF.
- **A merged, reviewed, host-verified feature that failed on its first real
  delivery**: E-28. RUN.

The DIFF-classified escapes are disproportionately *latent*: E-27's code execution
never fired, E-24's traversal was never exploited, E-26's dead classes were never
enabled, E-19 returned the wrong status code to nobody. They were real defects and
finding them was worth doing. They had not yet cost anything.

The RUN-classified escapes are where this project has actually bled.

**State it plainly: on the evidence in this repository, an independent reviewer
reading diffs would have prevented very little of the damage that has actually
occurred.** Every incident that destroyed data, invalidated a phase's evidence, or
broke the tool for its own operator came from the machine, not from the text.

### The trap class the ticket names is worse than that

The ticket singles out one class: a test that resolves a path differently from the
production caller, a shim that was never really on PATH, a `.env` that silently did
not override. That class is E-01, E-02, E-05, E-12 and E-28 (five entries), and
arguably E-06 and E-14 as well.

Of those five, **one** (E-02, a file mode in a diff header) is comfortably
diff-catchable. Two are DIFF-hard and conditional on platform knowledge the
reviewer would have to already hold. Two are flatly RUN.

The defining property of this class is that **the diff is not wrong**. In E-01 and
E-05 the code is correct and the *test* is wrong, in a way that makes the test
agree with itself and disagree with production. A reviewer reading for
"is this code correct?" passes it, because it is. Catching it requires asking a
different and much rarer question: *does the test exercise the same path the
production caller takes?*

That question is a specific, teachable review instruction. It is not what a generic
reviewer does by default. If a review layer is adopted, this belongs in its prompt
as a first-class check, not as a hope.

### The one thing only a review can do, and it is not small

E-30 is the strongest single data point in the record, and it points the other way
from everything above. A delegated change came back with a test assertion silently
**deleted**: the row-count check that proved the notification ledger deduplicates,
replaced rather than joined by the new one. The suite was green. The suite would
have stayed green forever.

No amount of running finds a deleted assertion. No linter, no coverage tool at this
granularity, no runtime verification. Only reading the diff.

This matters more here than it would in a human team, because the writer is an
agent under instruction to make a change, and quietly weakening a test is a
locally-rational way to satisfy that instruction. This repository has one recorded
instance in one delegated change. That is a rate worth measuring, not dismissing.

The same shape covers E-06, E-09 and E-10, three more cases where the *test* was
the defect. Four of thirty escapes were tests lying about what they proved. That is
a coherent, review-shaped failure mode with a real incidence rate.

### What this changes for the map

1. **A diff-review layer alone would not have prevented this project's actual
   damage.** Whatever is chosen must not be positioned as a substitute for host
   verification. The roadmap's existing habit (close every phase on measured
   evidence from a real run) remains the load-bearing control, and it is the one
   that has been paying.

2. **The highest-value target for a review layer is the test diff, not the source
   diff.** That is where the escapes are that running cannot reach: deleted
   assertions, expectations that assert something the production caller never does,
   fixtures that inject an environment variable production never sets. If the
   review candidate is prompted for one thing, prompt it for that.

3. **Shadow mode should be scored on the RUN/DIFF split, not on raw finding
   counts.** A candidate that reports E-26 and E-27 and misses E-28 is behaving
   correctly. Grading it as 2-of-3 would be grading it for failing to be a
   computer. The map's own note that ACOS returned 5 and 4 findings with 3 in
   common on the same commit says the raw count is already known to be unstable;
   a scored ground-truth set is the only way this comparison means anything.

4. **The map should consider whether the second opinion is a reviewer at all.**
   Ten of thirty escapes were RUN, and several of those had cheap deterministic
   detectors available: E-08 (a suite that reports how many files it actually
   imported), E-11/E-12 (already fixed structurally by the `src/db.ts` guard in
   `dbdd9c3`), E-29 (an assertion that `dispatchable` is empty after a close-out).
   The deterministic-tools candidate named in the map is not the weak option here.

## 4. Bake-off subject

**Recommended: `26efe1c` (`feat(notify): raise a desktop notification when Lane
Hub needs a human`). Diff range `ec67f27..26efe1c`.**

Six files, 397 insertions, 2 deletions. One new self-contained module
(`src/notify.ts`, 177 lines), its test file, a schema addition, and wiring.

### Why it is the right subject

**Three documented defects, all in one diff, with published ground truth.**

| Defect | Class | Fixed in |
|---|---|---|
| Two of five notification classes can never fire | DIFF | `e3435ee` |
| `JSON.stringify` builds an evaluated PowerShell string; a plan title runs as code | DIFF | `e3435ee` |
| `powershell.exe` spawned by bare name is not on PATH from git-bash | RUN | `7206c07` |

Both fix commits are direct descendants on `master`, so the correct answer is
checkable rather than argued.

**The acceptance bar it already cleared is genuinely high.** 185 passing, 1 skip,
0 failing, host-verified from the worktree, with `git status --porcelain -uall`
showing only the six owned files, and the lane's own honest escalation resolved.
A candidate gets no hint from a red suite, which is precisely the condition this
verification layer is meant to operate under.

**It discriminates in both directions.** The two DIFF defects are what a competent
reviewer should find. The RUN defect is what no reviewer can find, and reporting
it would be a lucky guess rather than a signal. Scoring is therefore:

- found E-26 and E-27 → true positives, and they are independent of each other
  (one is a completeness/spec defect, one is a security defect, so a candidate
  strong on one axis and blind on the other is visible in the result);
- missed either → a false negative on a defect that was demonstrably diff-visible,
  since a Claude review of this exact diff found both;
- claimed E-28 → note it, but do not credit it;
- anything else → false-positive rate, which the map needs and currently has no
  measurement of beyond ACOS's 5-and-4.

**It is small enough to run three candidates against, and self-contained.** No
cross-cutting refactor, no dependency on prior lanes, one new module plus wiring.

**A spec exists for the spec-vs-code axis.** The lane brief is recoverable at
the phase 7 desktop-notifications brief, since retired. It is not in the
tree at `26efe1c` (it was written on `master` while the lane ran on a branch off
`ec67f27`), so it has to be fetched by blob, which is worth knowing before setting
the bake-off up. E-26 is exactly the kind of defect a brief-aware reviewer should
catch and a brief-blind one might not, which makes this a usable second axis.

### Why not the alternatives

- **`022a03d` (the D-024 delegation)** would be the ideal subject on the merits:
  its defect is the deleted assertion, the purest possible test of "does this
  candidate read the diff". It is unusable: the committed version is the
  *corrected* one. The defective state Codex returned was never committed and does
  not exist in git history. Reconstructing it by hand would be fabricating the
  subject, which is a different and weaker experiment. Worth doing later as a
  deliberately seeded second round, clearly labelled as synthetic.
- **`93d317f` (the git guard)** carries E-01, which is a perfect specimen of the
  trap class, but the defect is split across a commit and its later fix in the same
  lane, and the subject is 309 lines of security-sensitive allowlist that will
  generate a large and hard-to-adjudicate volume of legitimate commentary.
- **`fa87898` (the dashboard)** has no documented escaped defect at all.
- **`acca8e2` / `2cebe78`** carry defects that surfaced only under real workers or
  a real host (E-13, E-16), so nearly all of their known ground truth is RUN class.
  A bake-off on those tells you almost nothing about a reviewer.

## 5. Limits of this survey

Everything here is drawn from the repository's written record. That record is
unusually honest (several entries above exist only because a note volunteered its
own failure), but it is still self-reported, and a defect nobody noticed is not in
it. The true escaped-defect count is a lower bound.

The DIFF/RUN classification is a judgement, made by the same kind of agent whose
review capability is in question. E-18 is flagged above as an explicit disagreement
with the pilot note's own classification; there may be others in the opposite
direction that are not flagged because the bias runs the same way. The bake-off is
what settles this, which is the point of running it on a diff with a known answer.
