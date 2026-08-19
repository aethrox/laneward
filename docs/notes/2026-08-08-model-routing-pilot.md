# Model routing pilot: Sol vs Terra vs Luna

Status: measured evidence (9 runs, 3 task shapes x 3 models, directional)
Date: 2026-08-08
Host: Windows 11 Pro 26200, codex-cli 0.147.0

## Why this exists

Laneward currently has no per-lane model field. `scripts/codex-round.ts` only
sets `model_reasoning_effort=high` and every lane inherits whatever model is
set in `~/.codex/config.toml`, on the verified Fedora conductor host that is
`gpt-5.6-sol`, the most expensive tier, regardless of how simple the lane is.

`sol-advisor`'s own role table already draws this distinction (implementer
roles on `gpt-5.6-terra`, the advisor role reserved for `gpt-5.6-sol`), which
prompted checking whether Laneward's routine lanes are paying for a tier they
don't need, and which tier actually fits which lane shape.

## Model tiers (OpenAI, GPT-5.6 family)

| Model | Price / 1M tokens (in / out) | Artificial Analysis Coding Agent Index |
|---|---|---|
| Sol | $5 / $30 | 80.0 |
| Terra | $2.50 / $15 | 77.4 |
| Luna | $1 / $6 | 74.6 |

OpenAI positions Sol for long-horizon work needing persistence across files
and tests, Terra for scoped implementation and first-pass review, and Luna for
fast, low-reasoning, repeatable work.

## The experiment

Three independent task shapes were run once per model (9 total runs), each
from the same commit (`deff9a2`), each in its own disposable git worktree, so
no run could interfere with another or with the real tree. All worktrees and
branches were deleted after comparison; nothing was merged.

- **Task A: routine formatting.** Pure `formatDuration(ms): string` helper
  (ms/s/m/s/h/m rendering, throw on invalid input) plus 8 named test cases.
  Bounded, single file, no ambiguity.
- **Task B: scoped logic with a real bug trap.** Pure `pathsConflict(a, b):
  boolean` helper for lane file-scope overlap detection (mirrors what
  `src/gate.ts` actually does), requiring path-*segment* comparison rather
  than naive string-prefix matching: `"src/auth"` must not conflict with
  `"src/authorization"`. Single file, but the correct solution needs one real
  reasoning step; the naive/wrong solution is shorter to write.
- **Task C: trivial one-liner.** `clampInt(n, min, max): number`. As
  mechanical as a coding task gets.

```
codex exec -m gpt-5.6-<sol|terra|luna> -s workspace-write \
  -c sandbox_workspace_write.network_access=false ...
```

## Result

| Task | Model | Wall time | Tokens used | Tests | Correct? |
|---|---|---|---|---|---|
| A (formatting) | Sol | 1m 20s | 37,893 | 2 tests / 8 assertions, pass | yes |
| A (formatting) | Terra | **43s** | **16,134** | 4 tests / 8 assertions, pass | yes |
| A (formatting) | Luna | 50s | 24,716 | 5 tests / 8 assertions, pass | yes |
| B (path overlap) | Sol | 43s | 31,809 | 7 tests / 8 assertions, pass | yes |
| B (path overlap) | Terra | **42s** | **16,942** | 8 tests / 8 assertions, pass | yes |
| B (path overlap) | Luna | 1m 1s | 23,458 | 7 tests / 8 assertions, pass | yes |
| C (clampInt) | Sol | 41s | 19,151 | 5 tests / 5 assertions, pass | yes |
| C (clampInt) | Terra | **39s** | **9,728** | 1 test / 5 assertions, pass | yes |
| C (clampInt) | Luna | 38s | 20,278 | 1 test / 5 assertions, pass | yes |

All 9 implementations were correct, including Task B's segment-vs-prefix trap;
every model (Sol, Terra, and Luna alike) correctly rejected
`"src/auth"`/`"src/authorization"` as non-conflicting rather than falling for
a naive `.startsWith()` bug. No quality difference was observed anywhere in
this sample.

### The unexpected part: Terra, not Luna, was the token/speed leader

Terra used the fewest tokens **and** ran fastest or tied-fastest on all three
task shapes, including beating Luna, the nominally "cheapest and fastest"
tier, on every single run. Luna was never the token leader in this sample.

This means Luna's lower sticker price does not automatically translate into
the lowest total cost: Luna spent 1.4x–2.1x as many tokens as Terra to reach
an equally-correct answer on every task tested here. Using an illustrative
85%-output/15%-input token split (not measured directly: `codex exec`'s
plain-text output does not expose the split, so this is a rough estimate, not
a fact) the approximate per-run dollar cost is:

| Task | Sol (est.) | Terra (est.) | Luna (est.) |
|---|---|---|---|
| A | $0.99 | $0.21 | $0.13 |
| B | $0.84 | $0.22 | $0.12 |
| C | $0.50 | $0.13 | $0.11 |

Under this estimate Luna is still the cheapest in dollars on all three (its
5x cheaper sticker price outweighs its token inefficiency), but by a much
smaller margin than the raw per-token prices suggest, and it bought no speed
or quality advantage over Terra anywhere in this sample. Terra was
consistently and by a wide margin cheaper and faster than Sol, with no
observed quality cost, on all three shapes.

## What this does and doesn't show

- 9 samples, 3 task shapes, all single-file and fully specified: none needed
  cross-file reasoning or long-horizon persistence across a working tree.
  Sol's published benchmark advantage specifically targets that kind of work
  (security, concurrency, wide refactors, migrations), which nothing here
  tested. Do not read "Sol showed no advantage" as "Sol is never needed."
- Dollar costs above are estimated from an assumed input/output token split,
  not measured. A follow-up pass with `codex exec --json` (which may expose
  the split per event) would replace the estimate with a real number.
- All runs used `model_reasoning_effort=high` (the current global default),
  not a tier-appropriate effort setting per model.

## Proposed routing (revised after the 3x3 pass)

| Lane type | Model | Basis |
|---|---|---|
| Routine or scoped-logic implementer (single file, fully specified, even with a real reasoning step) | **Terra** | fastest and most token-efficient in all 3 shapes tested, zero quality loss |
| High-complexity implementer (security, concurrency, wide refactor, migration, cross-file persistence) | **Sol** | untested here; matches Sol's published benchmark strength, not yet contradicted or confirmed locally |
| Advisor / review, first pass | Terra | matches OpenAI's own positioning ("first-pass review") |
| Advisor / review, final verdict | Sol | unchanged from `sol-advisor`'s own convention |
| Luna | no lane type recommended by this pilot | never won on speed or tokens against Terra in 3/3 tests; its dollar-cost edge is real but small and unproven beyond this sample; do not default to it without a separate pilot showing where it actually wins |

This reverses the prior version of this note, which proposed Luna as the
default for routine lanes based on a single Sol-vs-Luna sample. The 3x3 pass
shows Terra beating Luna on every axis except sticker price in every task
shape tried so far.

Recommendation is unchanged on mechanism: stamp the model as a static field
on the lane brief at creation time (matching the existing `owned_paths` /
scope pattern), not a runtime model-selection engine. The lane-type call is
already made by whoever writes the brief.

## Next step

Done on 2026-08-08: `lanes.model` (`sol` / `terra` / `luna`, default `terra`)
is validated by `POST /lanes`, returned by `GET /lanes/dispatchable`, passed to
`codex exec` as `-m gpt-5.6-<tier>` by `runCodex`, and set per lane through
`LANE_MODEL` in `scripts/new-lane.ts`. Verified end to end on Windows; not yet
observed on Linux, and no real lane has been dispatched on a non-default tier.

Still open: run this comparison on a handful of real historical lane briefs
(not synthetic ones), and specifically test a genuinely multi-file or
high-complexity lane before extending or narrowing Sol's reserved scope.
