# Windows, started

S3 from the shipping plan, run on 2026-08-19
against `839f64b` plus the three fixes it forced. `install.ps1` had registered a
Scheduled Task correctly since 2026-08-15 and the task had never run. It has now,
and what it ran was **a real Codex worker**, which also closes the seam S4.1 was
written about — on Windows rather than on Linux.

## What was run

Windows 11, the operator's own account, no elevation. Throwaway `-ConfigDir`,
`-DataDir` and `-TaskName laneward-s3`, a throwaway `laneward_s3` database on the
existing `postgres:16-alpine` in the Podman machine, and a throwaway git
repository as the driven project.

The database is addressed at the Podman machine's WSL address rather than
`127.0.0.1`, because **the machine's port forwarding to the Windows host was not
working**: `podman ps` reported `0.0.0.0:5433->5432/tcp`, no Windows process was
listening on 5433, and restarting both the machine and the container did not
restore it. The container is reachable at the machine's own WSL address from
Windows and from a sibling WSL distribution. `install.ps1` warned about exactly this, in the
words D-037 gave it, which is the warning doing its job.

## The result

```
s3-notes  registered through the API, dispatchable
          Start-ScheduledTask -TaskName laneward-s3
          state Running, conductor process carrying the config
~25s      s3-notes: completed
```

Between the start and the completion nothing was touched. The worker was the
real `codex` on this machine — 15,101 tokens, its own diff in the lane log — and
it ran under the Scheduled Task's environment: no terminal, no login shell, and
`buildWorkerEnv`'s stripped variables. **Codex's own credential lookup survived
that**, because `auth.json` lives under the profile directory and the strip
removes credential-bearing *variables*, not the profile.

The lane's evidence recorded `overall: not_configured` (the throwaway repository
declares no checks), `notes.txt` carried the requested line, and `git status` in
the worktree showed one modified file — the one the lane owned. The git-guard log
is empty: the worker ran no Git command.

That is the first time this project has run a real agent under a supervisor of
any kind, on any platform.

## Three defects, all in `install.ps1`, all fatal to a first-time user

Every one of them passes the test suite on both platforms, because none of them
is in the code the suite covers.

**1. The Scheduled Task carried none of the operator's configuration.** The
registered arguments were `run --no-env-file conductor.ts --loop` with the app
directory as the working directory. The app directory deliberately has no `.env`
and `--no-env-file` suppresses auto-loading, so the conductor started on pure
defaults: `PORT` reverting to 8787 while the hub listened on 8788, no
`DATABASE_URL`, no `MAX_ACTIVE_LANES`, no notification setting, no model
overrides and no declared agent. The only symptom would have been a connection
failure logged every interval, forever — D-014's defect 3 again, with no
`journalctl` to see it in.

The Linux units do not have this problem: both carry
`EnvironmentFile=@CONFIG_DIR@/.env`. A Scheduled Task has no equivalent, so the
config has to travel in the command line. `--env-file` before the subcommand
loads while `--no-env-file` after it still suppresses the working directory —
verified, both at once — so the task now runs
`--env-file="<config>\.env" run --no-env-file conductor.ts --loop`.

**2. The installer's own printed step 2 could not work.** It said
`cd $AppDir; bun run start`, and that exits immediately with `DATABASE_URL is not
set: copy .env.example to .env` — advice that is wrong here, because the config
deliberately lives in the config directory rather than the app directory. Step 3,
the migration, passed `--env-file` on the same page. Step 2 now does too.

**3. The printed recovery command had the same fault.**
`bun run reset-stranded --dry-run` cannot reach the database either. Fixed the
same way.

Two and three are one-line documentation faults; the first is a functional one
that would have made the Windows install non-working for anyone but its author,
who would have set the environment by hand without noticing.

## Stopping mid-lane, and recovering — B2's missing half

This is the path Linux structurally cannot test, because on Linux the lane is
handed back rather than stranded.

A second lane was dispatched and the task stopped while it ran:

```
Stop-ScheduledTask       task state: Ready
                         conductor and worker both gone, no orphan
                         s3-slow: running        <- stranded, no worker behind it
bun run reset-stranded   Reset 1 stranded lane(s) to pending: s3-slow
                         s3-slow: pending
Start-ScheduledTask      s3-slow: running        <- picked up again
```

Both halves observed. Windows terminates the whole process tree, so nothing is
orphaned, and nothing is handed back either — exactly what D-038 conceded rather
than solved. `reset-stranded` recovers it, and the recovery is effective rather
than cosmetic: the reset lane was re-dispatched on the next start.

## The declared agent, under a real supervisor

The slow lane's worker was declared through `LANEWARD_AGENT_WRITE` as a JSON
argument array pointing at a script that is not Codex and takes no Codex flags.
It was spawned correctly by the Scheduled Task, through the `.env` the task now
carries. S2b's adapter was accepted against a fixture in the test suite; this is
the first time it has run outside one.

## What this does not establish

- **The logon trigger.** Step 5 of S3 is a logoff/logon cycle, and it needs the
  operator to log out. Registration is verified; firing at logon is not.
- **Reboot.** Unchanged, and the Podman machine does not survive one either.
- **The shipped database container** (S2.4). This ran against the existing
  container, not against the quadlet the package installs.
- **Linux with a real agent under systemd.** Attempted first and blocked by the
  host: `user@1000.service` and `user@0.service` both fail with
  `Failed to spawn executor: Device or resource busy` under systemd 259 in WSL,
  so no user service of any kind can start there today. That is a WSL fault, not
  a Laneward one, and it is why S3 was done before S2.4.
- **Log directory isolation.** `install.ps1` creates and announces
  `<DataDir>\logs`, but the conductor resolves its log directory from
  `stateHome()` independently. They agree at the default and diverge only when
  `-DataDir` is overridden, so a throwaway install still writes lane logs to the
  real `%LOCALAPPDATA%\laneward\logs`. Not fixed: it costs nothing to a real
  operator and only complicates teardown for a test run.

## Cleaned up

`install.ps1 -Uninstall -Purge` against the throwaway roots — which is the first
time the uninstall path has run after a real install rather than a dry one. The
task was removed, both directories purged, the two worktrees removed, the
throwaway repository deleted, `laneward_s3` dropped, the stray lane logs deleted
from `%LOCALAPPDATA%`, and no `bun.exe` left running.

## Where S3 stands

Steps 1 through 4 are done and step 5 needs a logout. The three defects it found
are the argument for the stage: the Windows installer registered a task that
would have started, run forever, and completed nothing.
