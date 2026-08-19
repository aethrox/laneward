# Verification bake-off: four candidates on one real change

Evidence for wayfinder ticket #4 on map #2. This note records what each candidate
found. It does not pick a winner: that is ticket #7's job.

## Subject

`ec67f27..26efe1c`, the Phase 7 notifier lane. 6 files, 397 insertions, one
self-contained module (`src/notify.ts`) plus its suite (`tests/notify.test.ts`).

Ground truth, all three found on `master` **after** the change had cleared
185 pass / 1 skip / 0 fail and a clean owned-path check:

| id | class | defect | fixed in |
| --- | --- | --- | --- |
| **D1** | DIFF | `runtime_verification_required` and `plan_complete` are accepted by `LANEWARD_NOTIFY` and allowed by the `CHECK` constraint, but `candidates()` never emits either | `e3435ee` |
| **D2** | DIFF | the Windows toast composes its script with `JSON.stringify`, a PowerShell double-quoted string, so `$(...)` in a plan title runs as code on the host | `e3435ee` |
| **D3** | RUN | `powershell.exe` is not on `PATH` for a process started from git-bash, so the first real toast this host tried to raise failed | `7206c07` |

Each candidate ran **twice** on identical input, so run-to-run variability is
measured rather than assumed.

## How each candidate was run

All four ran against a detached worktree at `26efe1c`, never against `master`.

| candidate | invocation |
| --- | --- |
| Codex review lane | `codex exec -C <tree> -s read-only` with a fixed review prompt (below), model `gpt-5.6-sol`, reasoning effort `medium` |
| ACOS | `acos review <tree> --scope src/notify.ts --scope tests/notify.test.ts`, reviewer `claude-sonnet-5`, verifier `codex-cli 0.147.0` |
| Deterministic tools | `bun x tsc --noEmit`, `bun test`, `bun audit` |
| Independent clean run | fresh database, `bun install`, `bun run db:migrate`, seed, `bun run start` **from git-bash**, all five notification classes enabled, 8 s observation window |

The review prompt given to the Codex lane named the categories a standing review
step would name: correctness, security, runtime behaviour, cross-file contract
disagreement, tests that pass without proving what they claim; and named no
defect, no file, and no area of the change.

## Results

### Codex review lane

| | run 1 | run 2 |
| --- | --- | --- |
| findings | 5 | 4 |
| **D1** | miss | **hit** |
| **D2** | **hit** | **hit** |
| **D3** | miss | miss |
| false positives | 1 | 0 |
| wall clock | 239 s | 249 s |
| tokens | 76,596 | 91,087 |

Common to both runs: **D2**, and the poll loop clearing a disabled class's
deduplication record. Run 1 additionally reported that a notification row is
inserted before delivery is known to have succeeded, so a failed toast is never
retried: true, and the clean run below demonstrates it. Run 2 additionally
reported that the `plan_ready_for_review` query does not exclude superseded plan
revisions while `checkGate` refuses them (`src/gate.ts:33-40`), a real
cross-file contract disagreement that is **not** in the ground-truth list.

Run 1's false positive: the toast's `CreateToastNotifier('Laneward')`
AppUserModelID is not registered through a Start-menu shortcut, therefore the
toast will not display. This host disproved it the same day. Windows registers
the AppUserModelId itself on first use: `HKCU\...\Notifications\Settings\Lane
Hub` exists and counts the toasts, with no `Enabled=0`, no `ShowBanner=0` and no
quiet hours key. Both toasts were seen in the Action Center and their banners on
screen, one carrying `$(whoami)` in its title and rendering it as literal text,
which is also the visual proof of the PowerShell interpolation fix. (Measured
2026-08-09. Recorded here rather than cited, because the session note it came
from was ephemeral and has been removed.)

Neither run claimed **D3**. That is the correct outcome: `PATH` composition is
not readable from the diff, and a candidate claiming it from reading alone would
not have been credited.

### ACOS

| | run 1 | run 2 |
| --- | --- | --- |
| findings | 0 valid, 0 invalid | 0 valid, 0 invalid |
| **D1 / D2 / D3** | miss / miss / miss | miss / miss / miss |
| stage reached | reviewer (failed) | reviewer (failed) |
| wall clock | 142 s | 139 s |
| cost | unmeasured; ACOS reports "it was not free" | same |

ACOS produced nothing usable on this host, twice, for three independent reasons.
None of them is a judgement about what ACOS would find if it ran.

**It does not start.** `acos.py` invokes its agents as `subprocess.run(["claude",
…])` with no shell. On Windows the extensionless npm shim is not executable that
way, so every run dies at the reviewer stage with `FileNotFoundError: [WinError
2]`, after preflight has already reported `preflight ok`, because preflight uses
a `which`-style lookup that resolves the shim preflight cannot execute. The two
runs above were made against a scratch copy patched to `claude.cmd` /
`codex.cmd`; the unpatched tool is a hard failure on this machine.

**Its output contract does not survive this host's agent configuration.** Both
patched runs ended `unparseable output`. The reviewer is `claude.cmd -p` with
`--output-format json --json-schema`, and it inherits the user's global
`CLAUDE.md`, which mandates Turkish prose replies. The reviewer answered in
Turkish prose; ACOS could not parse it and discarded everything, reporting
`Findings: 0 valid, 0 invalid`.

**It cannot review a change.** ACOS reviews a *disposable export of the committed
revision*: a `git archive` extraction with no `.git`. Run 2 says so in its own
words: it could not perform a diff-based review and read the whole codebase
instead. `--scope src/notify.ts --scope tests/notify.test.ts` was also ignored in
both runs; the discarded prose discusses `scripts/new-lane.ts`, `src/gate.ts` and
`scripts/check-evidence.ts`. A whole-revision reader is a different instrument
from a pre-merge check on a change, and this bake-off could not measure it as the
latter.

Worth recording from the discarded prose, since it was paid for: run 2 reported
the `scripts/new-lane.ts` type mismatch that the deterministic typecheck also
flags (`{ name, env }` assigned to `{ name, url }`). Real, out of scope, and
thrown away by ACOS's own pipeline.

### Deterministic tools

| | run 1 | run 2 |
| --- | --- | --- |
| findings inside the change | 0 | 0 |
| **D1 / D2 / D3** | miss / miss / miss | miss / miss / miss |
| output outside the change | 5 `tsc` errors, 4 dependency advisories | identical |
| wall clock | 42 s | 39 s |
| cost | none | none |

`bun test` at `26efe1c` returns **185 pass / 1 skip / 0 fail**: it confirms the
ticket's premise that the suite was green while all three defects were live.

`tsc --noEmit` does not run in this repo as it stands: `tsconfig.json` names the
`bun-types` type library and no package provides it, so the first invocation
fails with `TS2688` before checking anything. With `bun-types` installed the
typecheck reports 5 errors, all in `scripts/` and `tests/git-guard.test.ts`:
files the change does not touch. Zero errors in `src/notify.ts` or
`tests/notify.test.ts`.

`bun audit` reports 4 dependency advisories (3 moderate, 1 low), none introduced
by the change.

Run-to-run overlap is 100%, character for character. That is the property this
candidate is bought for, and it is the only candidate that has it.

### Independent clean run

| | run 1 | run 2 |
| --- | --- | --- |
| **D1** | **hit** | **hit** |
| **D2** | miss | miss |
| **D3** | **hit** | **hit** |
| false positives | 0 | 0 |
| wall clock | 12 s | 11 s |
| cost | none | none |

Both runs, identical output:

```
Started development server: http://127.0.0.1:8799
desktop notification failed: Error: Executable not found in $PATH: "powershell.exe"
desktop notification failed: Error: Executable not found in $PATH: "powershell.exe"
desktop notification failed: Error: Executable not found in $PATH: "powershell.exe"
```

That is **D3**, reproduced verbatim, in eleven seconds, from a shell an operator
actually uses.

With all five classes enabled, three emitted and two never did:

```
 approval_required     | lane | L1
 lane_failed           | lane | L2
 plan_ready_for_review | plan | 2222...

 enabled classes that emitted nothing:
 runtime_verification_required
 plan_complete
```

That is **D1**, from the outside, without reading a line of the diff. It is
reached by exercising the whole documented configuration surface rather than the
default one: a clean run that only enables the defaults would have missed it.

The run also demonstrated the defect Codex run 1 reasoned to: all three
notification rows were written with `sent_at` set even though **every** spawn
failed, so the failed toasts will never be retried.

**D2** was not reached. The spawn never got as far as PowerShell, and the seeded
plan titles were benign. A clean run surfaces what the run actually does; it does
not probe for what hostile input would do.

## Scoreboard

| | D1 (DIFF) | D2 (DIFF) | D3 (RUN) | FPs | new true defects | determinism | wall clock |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex review lane | 1 of 2 runs | 2 of 2 | 0 of 2 | 1 | 3 | ~50% overlap | ~4 min |
| ACOS | 0 of 2 | 0 of 2 | 0 of 2 | 0 | 0 | 100% (both failed) | ~2.5 min |
| Deterministic tools | 0 of 2 | 0 of 2 | 0 of 2 | 0 | 0 | 100% | ~40 s |
| Independent clean run | 2 of 2 | 0 of 2 | 2 of 2 | 0 | 1 | 100% | ~12 s |

## Judged on the test diff

The research ticket found that 4 of 30 escapes were tests lying about what they
proved, a class only a diff read finds. Only one candidate addressed the test
diff at all: the Codex lane, in both runs, reported that the Windows assertion in
`tests/notify.test.ts` only checks that the generated script *contains* the
`JSON.stringify` output and never parses or executes it, so the test passes while
the interpolation defect is live. Neither the deterministic tools nor the clean
run can see this class, by construction.

## Operating notes

Two things had to be true before any of this ran, and neither was:

- The database is not reachable at the documented `localhost:5433`. Connections
  resolve only at the podman machine's own address on port 5433. `.env` had to be
  rewritten for every candidate that touches the database.
- `bunx` is not on `PATH` under git-bash; `bun x` is.

## Raw material

- Review prompt, per-run outputs, logs and timings: session scratchpad
  `bakeoff/` (`codex-run{1,2}.md`, `acos-run{1,2}.log`,
  `deterministic-run{1,2}.log`, `clean-run{1,2}.log`, `clean-run.sh`).
- The clean-run procedure is `clean-run.sh`, reproducible as written.
