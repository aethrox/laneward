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

## 1. Done, and it was the last unobserved seam

~~**A real agent under systemd.**~~ **Done 2026-08-20**
([evidence](2026-08-20-real-agent-under-systemd.md)). The conductor sat idle for
forty seconds, picked up a lane registered through the API, spawned `claude`
under `laneward-conductor.service` with no terminal and the stripped
environment, and recorded the lane `completed` with its evidence. The lane wrote
exactly the one file it owned.

It also showed something the preset comment does not say: the nine Git refusals
in the guard log are the agent's **internal** calls, which
`--disallowedTools "Bash(git *)"` does not reach. All of them were reads, so
`check-evidence` passed them, but an agent whose internal Git use includes a
write would fail a lane for a reason its operator could not predict from the
preset.

## 2. Needs one action from the operator

~~**The Windows logon trigger.**~~ **Done 2026-08-20**
([evidence](2026-08-20-windows-logon-trigger.md)). Both tasks fired at logon,
tolerated a database that was not there yet, and completed a lane with a real
agent once it arrived. It also found that `install.ps1` had been registering
only the conductor and never the hub, which would have left a first-time
Windows user with a task reporting `Running` and a dashboard that never loads.

**Reboot survival, and logout on Linux.** A logoff and logon is not a cold boot,
so Windows still has a reboot to survive. On Linux `WantedBy=default.target`
stops at logout unless `loginctl enable-linger` is set, which the installer says
and nobody has tested. Linger is a persistent host change and needs its own
approval, which is why the installer will not do it on your behalf.

Note that nothing starts the Podman machine at logon, and nothing here should:
it is a machine-wide service rather than Laneward's to register. Both platforms
therefore come up before their database does, which this run showed they
survive.

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

**Visibility.** ~~The repository is private.~~ Public since 2026-08-20. The last
distribution step, taken after a final sweep found no host details, no
credentials and no tracked `.env` across nine commits and the whole tree. The
scrub that made it safe is recorded in
[the rename note](2026-08-19-clean-repository-and-rename.md).

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
