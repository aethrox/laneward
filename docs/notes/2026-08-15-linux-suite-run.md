# The suite under Linux, 2026-08-15

D-022 makes Windows and Linux both first-class, and everything built on
2026-08-15 (the reader layer, D-035, and the clean run's interpreter rule) had
only ever run on Windows. This is the Linux measurement, taken the same day.

## What was run

The repository checkout on the Windows disk, driven from the default WSL
distribution, against the same Postgres the Windows host uses:

```
wsl -e bash -lc 'cd /mnt/c/Users/<user>/Documents/Github/laneward &&
  DATABASE_URL=postgres://laneward:laneward@<podman-machine-ip>:5433/laneward_test bun test'
```

`bun` is installed inside WSL at `/home/<user>/.bun/bin/bun`, and the container
published on `5433` is reachable from there.

## Result

**275 pass, 0 fail, 927 expect() calls, across 32 files, in 160 s.**

On Windows the same commit is 274 pass, 1 skip, 0 fail. The difference is one
test, not a coincidence: `tests/conductor.signals.test.ts` skips
"SIGINT kills the children and hands the lanes back to HUB" on `win32`, because
Windows terminates the process rather than raising a catchable event, which the
roadmap records as a real gap. Under Linux that test runs and passes, so the
conductor's signal cleanup is verified on the platform where it can work.

`tests/git-guard.test.ts` also passed, which is the first Linux evidence for the
Git shim that D-023 relies on and that the README still lists as unverified.

## What this does and does not establish

It establishes that the code merged on 2026-08-15 is not Windows-only: the
spawn-based layers, the reader, the clean run's interpreter resolution and the
per-lane database machinery all behave under Linux.

It does not establish that the *system* has been operated on Linux. Nothing here
started a hub, ran a conductor pass, built a candidate or spawned a real
`codex` from Linux, and the WSL distribution has no `podman`, so a Linux host
would reach a database some other way. A green suite is evidence about the code,
not about the deployment, and D-013 asks for the second before calling a
platform done.
