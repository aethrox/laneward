# Writing briefs

The brief is the entire contract. It arrives on the agent's stdin and nothing
else does: the agent cannot see the conversation that produced it, the plan it
belongs to, or the other lanes running beside it. Start from
[the template](../brief-template.md); what follows is your side of it.

## Why a vague brief gets scored wrong

The conductor decides a lane's outcome from what the log says and what the diff
shows. A lane that stops without saying why is scored from its diff alone, which
is how a correct lane gets marked `failed` and an unverified one gets marked
`completed`. Everything below exists to stop that.

## Owned paths are globs over files {#owned-paths}

This is the single most common way a correct lane fails.

`owned_paths` is matched against every path `git status --porcelain -uall`
reports in the worktree, as an anchored glob in which `*` matches anything
except `/`. A directory name matches the directory and nothing inside it.

Measured on a scratch repository with two changed files,
`src/auth/login.ts` and `src/auth/deep/util.ts`:

| `owned_paths` | Result |
|---|---|
| `src/auth` | `FAIL: ownership violation: src/auth/deep/util.ts src/auth/login.ts` |
| `src/auth/*` | `FAIL: ownership violation: src/auth/deep/util.ts` |
| `src/auth/*` `src/auth/*/*` | `PASS: 2 changed path(s), all within owned_paths` |

So write one pattern per directory level you expect to be touched, and name
individual files where you can:

```bash
bun scripts/new-lane.ts fix-login brief.md \
  'src/auth/*' 'src/auth/*/*' 'tests/auth/*'
```

!!! note "Registration and scoring use different rules on purpose"

    The overlap check that stops two lanes claiming the same ground compares
    paths as prefixes, so registering `src/auth` does reserve everything under
    it against other lanes. Only the after-the-fact evidence check is a glob.
    A path list that reserves correctly can still score wrong, which is why the
    table above is worth testing against your real tree.

## List every file the change forces you to touch

Side effects included: the test that has to move with the code, the fixture the
test needs, the doc whose claim stops being true. Say so in the brief as well as
on the command line, because the agent only sees the brief:

```markdown
## Scope

You own exactly these files:

- `src/auth/login.ts`
- `tests/auth/login.test.ts`

Do NOT touch anything else, and never anything under `.git`.
```

A lane that edits a file outside its `owned_paths` is failed by the evidence
check even when its work is correct. Being generous here costs you a blocked
neighbour; being stingy costs you a wasted run.

## The escalation block is not decoration

The agent has three signals, and none of them is a message: exit `0` (done),
exit `10` (approval), anything else (failed). So the brief must tell it how to
speak. Two markers are read out of the log, and both must start a line:

```
APPROVAL REQUIRED: [your question]
HOST VERIFICATION REQUIRED: [what is unverified, and the command that would verify it]
```

- **`APPROVAL REQUIRED`** is for a brief that is wrong, ambiguous, or asks for
  something the agent should not do. It changes nothing and stops.
- **`HOST VERIFICATION REQUIRED`** is for work that is finished but carries a
  claim the agent could not check: a sandbox denial, an unreachable service,
  hardware it cannot touch.

Either marker parks the lane in `waiting_approval`. You answer, and the lane is
dispatched again with your decision appended to the original brief under an
`--- APPROVAL DECISION ---` heading, so nothing is lost and nothing is scored on
a guess.

!!! tip "An echoed brief cannot escalate a lane by accident"

    A marker line that is verbatim a line of the brief is ignored, and a marker
    mentioned mid-sentence is ignored too. That is why the template's own
    example markers are safe to leave in the text you hand over.

## Write the definition of done as a command {#definition-of-done}

```markdown
## Definition of done

- `bun test tests/auth` is green. Baseline before your change is 41 pass.
- Every new branch is covered by a test that fails if the branch is removed.
- No file outside the owned list is modified.
```

The baseline number matters: without it an agent that breaks two unrelated tests
and fixes three can report green. The exact command matters because the driven
repository's [declared lane checks](driven-repo.md) run the same ground
afterwards, and a brief that asks for something the checks do not measure is a
brief you cannot trust.

## Say what must never be touched

```markdown
## Environment notes

- The lane has its own database. Never point anything at `laneward` or at the
  production connection in the repository root `.env`.
- Port 8787 belongs to the hub. Do not bind it.
- Code, comments, tests and docs are English.
```

Name the destructive mistakes, not only the correct choices. Lanes have written
their escalation messages in the wrong language and pointed test runs at the
wrong database; both were fixed by one sentence in the brief.

## A time limit

End with `Time limit: [N] minutes.` Nothing enforces it (there is no timeout on
the agent process itself) but it changes how an agent budgets a hard problem,
and it gives you a number to compare against when you go looking at a lane that
has been `running` for an hour.
