# Daily operation

Once lanes are running, three things need you: approvals, failures, and getting
finished work out. Everything below is what happens between them.

## The commands

```bash
bun run start                                     # hub and dashboard
bun run conductor --loop                          # keep draining
bun run conductor                                 # one pass, then exit

bun scripts/new-lane.ts <id> <brief> <paths...>   # register a lane
bun run build-candidate <plan-id>                 # integrate a finished plan revision
bun run reset-stranded --dry-run                  # what a crash left behind
bun run teardown <lane-id>                        # drop the lane's worktree, branch and database
```

## The dashboard

[http://127.0.0.1:8787](http://127.0.0.1:8787). It does not poll: the page opens
one event stream and the hub pushes when something changes, so the indicator
next to the title reads `live`, or `disconnected, retrying` if the hub went
away.

**Plan cards** carry the revisions, which one is newest, who approved it, and
the verification ladder for that revision: construction, clean run, reader, each
with its status and attempt number, plus any unmet clean-run expectations by
name. Open reader findings are listed under the revision with their locations
formatted as `path:start-end (side)`.

**Lane cards** carry a status pill (`pending`, `running`, `waiting_approval`,
`completed`, `failed`), then a summary line of lane type, attempt count, how
long since the lane last moved, and its owned paths. Below that: the newest ten
pieces of evidence, every approval with its decision and who resolved it, a live
tail of the agent's log, and a `whole log` link to the complete file.

A lane waiting on you shows the question as a quote with its `approval_id`
underneath. That id is what you post back.

## What needs me right now {#pending}

```bash
curl -s http://127.0.0.1:8787/pending
```

Three lists in one answer:

- **`waiting_approval`**: lanes that asked a question, and plan revisions whose
  candidate construction failed. Each carries the question text and the id.
- **`failed`**: lanes that used up their attempts.
- **`findings`**: open reader findings, newest first, with the plan and revision
  they belong to.

This is the same query the desktop notifier and the Claude Code bridge read, so
if it is empty, nothing is blocked.

## Resolving an approval

```bash
curl -s -X POST http://127.0.0.1:8787/approvals/<approval_id> \
  -H 'content-type: application/json' \
  -d '{"resolved_by":"human","decision":"Yes. Rejecting an empty password is in scope; do not touch the session code."}'
```

`resolved_by` is `human` or `claude` and is required. `decision` is free text and
is what the lane sees: it is appended to the original brief under
`--- APPROVAL DECISION ---` when the lane is dispatched again. Write it as an
instruction, not as a note to yourself. `verified_by` is optional and records who
checked the claim.

An approval can only be resolved once; a second attempt answers `409 approval
already resolved`.

## Notifications

Four classes, two of them on by default:

| Class | Fires when | Default |
|---|---|---|
| `approval_required` | A lane or a plan revision is waiting on a human | on |
| `lane_failed` | A lane reached `failed` | on |
| `plan_ready_for_review` | Every lane on a revision is `completed` | off |
| `findings_to_adjudicate` | A reader run produced findings nobody has judged | off |

Set them with `LANEWARD_NOTIFY`; an empty value turns desktop alerts off
entirely. Delivery is `notify-send` on Linux and a toast on Windows. **macOS
gets nothing**, logged as `desktop notification unavailable on darwin`; the
dashboard and `GET /pending` still carry everything.

A notification is sent once per condition and cleared when the condition goes
away, so a lane that stays failed does not toast you every second.

## Logs

One directory, from `LANEWARD_LOG_DIR` or the platform state directory:

| File | What it holds |
|---|---|
| `<lane_id>.log` | Everything the agent wrote. Blanked before each attempt, so it is always the current run. |
| `<lane_id>.git-guard.jsonl` | One line per git call the shim refused, with the arguments and whether it looked like a read. |
| `<lane_id>.check-<n>-<name>.log` | Output of one declared lane check. |
| `<plan_revision_id>.log` | A candidate build. |
| `<worktree>.reader.log` | A reader run. |

The dashboard reads the same files, so `whole log` and `cat` show the same
thing.

## After a crash

A conductor that is killed without warning, a reboot, or a stopped Windows task
leaves lanes `running` with nothing behind them.

```bash
bun run reset-stranded --dry-run       # list them, change nothing
bun run reset-stranded                 # return them to pending
bun run reset-stranded --lane fix-login  # just this one
bun run reset-stranded --failed        # retry genuinely failed lanes, attempt count cleared
```

A stranded lane keeps its attempt count, because the machine took that attempt
rather than the agent. A plain run also reclaims a construction attempt left
`running` by the same crash.

!!! warning "`reset-stranded` resets every running lane"

    It cannot tell a stranded lane from a healthy one. Stop the conductor first,
    or you will pull the floor out from under a lane that is working.

On Linux a conductor stopped with `SIGTERM` does not strand anything: it kills
its agents, hands each lane back to the hub, and exits 0. Windows has no
catchable `SIGTERM`, so stopping the scheduled task always leaves stranded lanes
and `reset-stranded` is the recovery.

## Getting work out, and cleaning up

Laneward never commits, merges or pushes. Finished work is uncommitted in the
lane's worktree on `lane/<lane_id>`. Review it, commit it, merge it in your own
repository, then:

```bash
bun run teardown fix-login
```

Teardown drops the lane database, removes the worktree and deletes the branch,
and refuses to remove anything while the worktree is dirty or the branch carries
commits your repository does not have. It names what it found, and nothing is
deleted for you that you have not integrated.

To drop a lane that never ran, `DELETE /lanes/:id` removes its record; a running
lane is refused with `409 cannot delete a running lane`.
