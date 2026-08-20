# Lane brief template

Copy this file, fill in the bracketed parts, and pass it to
`bun scripts/new-lane.ts <lane_id> <brief-file> <owned_path>...`.

The escalation block at the bottom is not optional decoration. The conductor
decides a lane's outcome from what the log says and what the diff shows; a lane
that stops without saying why is scored from its diff alone, which is how a
correct lane gets marked `failed` or an unverified one gets marked `completed`.

---

## Task: [one line, what this lane delivers]

Working directory: `[absolute worktree path]`

## Context

[Why this work exists. What is broken or missing, in terms of observed
behaviour rather than a description of the desired patch. Point at the file and
line where it goes wrong.]

## Required behaviour

[What must be true when you are done. Describe the outcome, not the
implementation, unless the implementation is itself the decision.]

## Scope

You own exactly these files:

- `[path]`
- `[path]`

Do NOT touch anything else, and never anything under `.git`.

`owned_paths` must list **every file the change forces you to touch**, side
effects included: the test that has to move with the code, the fixture the test
needs, the doc whose claim stops being true. A lane that edits a file outside
its `owned_paths` is failed by the evidence check even when its work is
correct.

## Tests

[The specific cases that must be covered, in the existing style of the repo.
Name the branches that must fail if removed.]

## Definition of done

- `[the exact command]` is green. Baseline before your change is `[N]` pass.
- Every new branch is covered by a test that fails if the branch is removed.
- No file outside the owned list is modified.

## Environment notes

- [Ports, databases, credentials, anything that is destructive if guessed
  wrong. Say what must never be touched, not only what to use.]
- Code, comments, tests and docs are English.

## Escalation: read this before you stop

The agent has no custom exit codes beyond 0 (done), 10 (approval), and
non-zero (failed), so exiting is not how you report a problem. If you stop
without escalating, your outcome is inferred from the diff alone.

**If the brief is wrong, ambiguous, or asks for something you should not do:**
change nothing and print, on a line of its own:

```
APPROVAL REQUIRED: [your question]
```

**If you finished the work but could not verify a claim**, for example a sandbox
denial, a service you cannot reach, or hardware you cannot touch, print, on a
line of its own:

```
HOST VERIFICATION REQUIRED: [what is unverified and the command that would verify it]
```

Both must start the line. A marker mentioned mid-sentence is ignored on
purpose, so an echoed brief cannot escalate a lane by accident. Either marker
parks the lane in `waiting_approval`, where an operator answers and the lane is
dispatched again with the decision appended, so nothing is lost and nothing is
scored on a guess.

Do not report work as done that you could not verify. Saying so is the
supported path, not a failure.

Time limit: [N] minutes.
