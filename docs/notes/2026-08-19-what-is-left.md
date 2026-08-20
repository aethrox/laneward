# What is left

Written 2026-08-19, replanned 2026-08-20 after the agent-neutral change and
after Codex stopped being available on this machine. It replaces three
overlapping planning documents that between them had grown to 7,500 words
describing mostly finished work. This is the one list, in the order the items
should be taken.

The evidence notes beside it are the record of what was *done*, and they stay:
[D-014 demonstrated](2026-08-15-d014-demonstrated.md),
[Windows end to end](2026-08-19-s3-windows-end-to-end.md),
[the shipped database container](2026-08-19-s24-shipped-database-container.md),
[the clean repository and the rename](2026-08-19-clean-repository-and-rename.md).

## What changed on 2026-08-20

There is no Codex subscription on this machine. Two consequences, and they pull
in opposite directions, which is why this file was replanned rather than
amended.

It **unblocks** the systemd item below. That item was blocked on a judgement
call rather than on work: driving a real agent under systemd meant putting Codex
credentials on a disposable Linux host. The `claude` preset removes the need,
because there is now a second real agent to drive it with.

It **defers** anything that needs Codex itself, which is now exactly one item:
re-running the `codex` preset for real. Nothing else in this project depends on
it. Delegation of implementation work goes to subagents rather than
`codex exec` for the same reason.

## 1. Do next, and nothing blocks it

**A real agent under systemd.** The last seam this project has never observed.
A real agent has completed a lane under the Windows Scheduled Task, with the
stripped environment and no terminal. Under systemd every lane so far has used a
fixture or a declared test agent, and a systemd user service is a genuinely
different environment: a constructed `PATH`, no terminal, no login shell, and
`buildWorkerEnv`'s stripped variables. It is the seam most likely to surprise a
first-time Linux user, because it is the first thing they do that this project
never has.

The Linux host is the privileged Fedora container on the Podman machine, the
same one the shipped database container was exercised in. The agent is `claude`,
whose credentials live in the profile directory rather than in an environment
variable, so the strip does not remove them.

**Done when:** a lane registered through the API completes with nobody attached,
under `laneward-conductor.service`, driven by a real agent, with its evidence
recorded and the journal showing the dispatch.

## 2. Needs one action from the operator

**The Windows logon trigger.** `install.ps1` registers a Scheduled Task at
logon. The task has been started by hand and drives lanes correctly, but it has
never fired from an actual logoff and logon. One logout closes it.

**Reboot and logout survival.** Neither platform has survived either. On Linux
`WantedBy=default.target` stops at logout unless `loginctl enable-linger` is
set, which the installer says and nobody has tested. Linger is a persistent host
change and needs its own approval, which is why the installer will not do it on
your behalf. On Windows the logon trigger above is the same question wearing
different clothes.

Take these together: one logoff and logon cycle, and one reboot, answer all
three.

## 3. Deferred until Codex is available again

**Re-run the `codex` preset for real.** Codex drove a lane end to end on
2026-08-19, before the agent-neutral change. That change did not alter the
argument array it is spawned with, but it did start setting the child's working
directory and it renamed the model tiers, so the codex path is currently covered
by tests rather than by a run. The risk is low and the fix if it is wrong is
small. It is listed so nobody mistakes test coverage for a run.

## 4. Deferred, and deliberately so

**More presets.** Only `codex` and `claude` ship, because only those two were
run against this project. Adding an agent is a preset **plus a real lane driven
by it**, in that order, and never the preset alone. A preset written from a help
text is a guess with an argument array around it.

Two things learned from adding the second one, worth knowing before a third. An
agent that reaches for Git to orient itself will have those calls refused, and
that is survivable now, but its *mutating* calls will still fail the lane. And
an agent with no way to express a read-only mode disables the reader rather than
running it unconfined, so check for one before writing the preset.

## 5. Decisions, not work

**Visibility.** The repository is private. Going public is the last distribution
step, and the host details that used to make it awkward are gone
([the rename note](2026-08-19-clean-repository-and-rename.md)).

**Clean shutdown on Windows (CP-3).** Windows has no catchable `SIGTERM`, so
stopping the conductor strands its lanes. Two ways to stand:

1. *Accept it and make recovery the mechanism.* This is the current position and
   it is now evidenced rather than assumed: stopping the task kills the tree with
   no orphan, `reset-stranded` returns the lane to `pending`, and the next start
   picks it up. `tests/reset-stranded.test.ts` asserts that behaviour.
2. *A cooperative stop signal* the loop polls between passes, so a stop is
   honoured at a pass boundary. Real work, and worth it only if stranding turns
   out to cost something in practice.

Recommendation: stay with 1 until it hurts.

## Deliberate gaps, not defects

These are decisions about what Laneward is for. They are listed so nobody
mistakes them for oversights.

- **Plan creation and approval are manual.** The bridge exists; no editor drives
  it end to end.
- **Commit, merge and push are manual**, by D-009 and D-011.
- **Secrets.** `scripts/new-lane.ts` copies the driven repository's `.env` into
  the lane worktree, so a worker reads real secret values. Only `DATABASE_URL`
  is rewritten, to a database made for that lane. Redaction is unimplemented and
  the README says so above the install instructions rather than below them.
- **Multi-conductor operation is unsafe** and nothing prevents a second one.
  `reset-stranded` warns in prose; the hub does not enforce it.
- **Single user, `127.0.0.1`, no authentication.** The reason the README says
  not to expose it.

## Host faults that decide what can be tested here

Not project work, but they shape every item above.

- No systemd user manager starts in this WSL: `user@1000` and `user@0` both fail
  with `Failed to spawn executor: Device or resource busy` under systemd 259.
  Linux verification therefore runs in a privileged Fedora container on the
  Podman machine, which is real systemd and real podman but a shared kernel, so
  it is not evidence about bare metal.
- The Podman machine's port forward to the Windows host is dead. A container
  reports its port published while nothing listens on the Windows side; the
  machine's own address is the only route. Both installers now warn when the
  configured `DATABASE_URL` is unreachable, which is the one-line version of a
  diagnosis this cost once.
