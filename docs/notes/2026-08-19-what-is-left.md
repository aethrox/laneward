# What is left

Written 2026-08-19. This replaces three overlapping planning documents (a
remaining-work list, a shipping plan and a stage plan) that between them had
grown to 7,500 words describing mostly finished work. Anyone who wanted to know
what was still open had to reconcile all three. This is the one list.

The evidence notes beside it are the record of what was *done*, and they stay:
[D-014 demonstrated](2026-08-15-d014-demonstrated.md),
[Windows end to end](2026-08-19-s3-windows-end-to-end.md),
[the shipped database container](2026-08-19-s24-shipped-database-container.md).

## Blocked on one action from the operator

**The Windows logon trigger.** `install.ps1` registers a Scheduled Task at
logon. The task has been started by hand and drives lanes correctly, but it has
never fired from an actual logoff/logon cycle. One logout closes it.

**Reboot and logout survival.** Neither platform has survived either. On Linux
`WantedBy=default.target` stops at logout unless `loginctl enable-linger` is
set, which the installer says and nobody has tested; linger is a persistent host
change and needs its own approval. On Windows the logon trigger above is the
same question.

**A real agent under systemd.** A real Codex worker has completed a lane under
the Windows Scheduled Task, with the stripped environment and no terminal. Under
systemd every lane has used a fixture or a declared test agent, because putting
Codex credentials on a disposable Linux host is a decision rather than a step.
This is the seam most likely to surprise a first-time Linux user.

## Deferred, and deliberately so

Written down rather than done, so they stop occupying anyone's attention until
they are worth the cost.

**More presets.** Only `codex` and `claude` are shipped, because only those two
were verified by running them here. Another agent is a preset plus a real lane
driven by it, in that order, and never the preset alone.

## Decisions, not work

**Visibility.** The repository is private. Going public is the last distribution
step; the host details that used to make it awkward are gone
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

- **Plan creation and approval are manual.** The bridge exists; Claude Code does
  not drive it end to end.
- **Commit, merge and push are manual**, by D-009 and D-011.
- **Secrets.** `scripts/new-lane.ts` copies the driven repository's `.env` into
  the lane worktree, so a worker reads real secret values. Only `DATABASE_URL`
  is rewritten, to a database made for that lane. Redaction is unimplemented and
  the README says so above the install instructions rather than below them.
- **Multi-conductor operation is unsafe** and nothing prevents a second one.
  `reset-stranded` warns in prose; the hub does not enforce it.
- **Single user, `127.0.0.1`, no authentication.** The reason the README says
  not to expose it.

## Host faults that block Linux work here

Not project work, but they decide what can be tested on this machine.

- No systemd user manager starts in this WSL: `user@1000` and `user@0` both fail
  with `Failed to spawn executor: Device or resource busy` under systemd 259.
  Linux verification therefore runs in a privileged Fedora container on the
  Podman machine.
- The Podman machine's port forward to the Windows host is dead. A container
  reports its port published while nothing listens on the Windows side; the
  machine's own address is the only route. Both installers now warn when the
  configured `DATABASE_URL` is unreachable, which is the one-line version of a
  diagnosis this cost once.
