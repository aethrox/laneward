# D-014, demonstrated

The claim this project is built around — *approved lanes continue after Claude
exits* — had never been observed on any platform. It has now. This is A2 from
the remaining-work plan, run on 2026-08-15
against `65b8b9d` plus the three fixes it forced.

## What was run

Fedora Linux 44 under WSL, systemd as PID 1, `systemctl --user`. The database was
the existing `postgres:16-alpine` on the Windows Podman machine, reachable from
WSL at `<podman-machine-ip>:5433`, with a throwaway `laneward_a2` database.

**No packages were installed.** The plan assumed A2 needed `podman` and
`notify-send` in WSL. It needed neither: the database already existed and
`LANEWARD_NOTIFY=` switches the notifier off deliberately. What actually blocked
it was `install.sh` demanding `podman` unconditionally — see below.

`CODEX_BIN` pointed at `tests/fixtures/fake-codex.ts`. **The worker was a
fixture, and that is a real limit on this result.** What D-014 claims is that the
conductor keeps dispatching and recording after the operator walks away; the
worker's own behaviour is a separate question.

To be exact about what that leaves open: a real Codex worker *has* driven a lane
to a recorded verdict on this project, on 2026-08-08
([the neura-system pilot](2026-08-08-phase4-pilot-neura-system.md)). What has
never happened is a real Codex worker under a **supervised service**, which is a
genuinely different environment — constructed `PATH`, no terminal, no login
shell, and a deliberately stripped environment from `buildWorkerEnv`. Codex's own
credential lookup has never been exercised there.

## The result

```
19:59:20  lane a2-demo2 registered through the API
19:59:20  a2-demo2: started          (conductor journal)
19:59:21  a2-demo2: completed
```

Between those lines nothing was touched. The conductor had been running as
`laneward-conductor.service` since 18:33 — **86 minutes idle** — picked the lane
up on its own, dispatched the worker, ran the evidence check, and recorded the
lane `completed` with its lane-check evidence attached
(`overall: not_configured`, since the throwaway repository declares no checks).

`systemctl --user status` reported both units active, and the API answered
`GET /pending` and `GET /lanes` over HTTP throughout.

### The first lane failed, correctly

`a2-demo` was registered owning only `work.txt`. The fixture also writes
`.prompt`, so `check-evidence` exited 1 with `violation: .prompt` and the lane
failed. Nothing was wrong: an unattended worker touched a path it did not own and
the ownership gate stopped it without a human present. The second lane declared
`.prompt` and completed.

That is a better first result than a clean pass would have been.

### Clean shutdown, under a real service manager

A third lane was left running and the unit stopped mid-lane:

```
20:00:07  SIGTERM received - stopping 1 running lane(s)
20:00:07  a2-slow: handed back to HUB
          unit state: inactive     unit Result: success
          lane a2-slow: pending
```

`Result: success` rather than `failed` is the `SIGTERM` exit-0 change from Stage
5a doing what it was written for. The lane returned to `pending` with no manual
cleanup, which is what makes a reboot safe. This also closes the half of B2 that
asked for a strand-and-recover round trip — on Linux the lane is handed back
rather than stranded, so `reset-stranded` was not needed at all.

## Three defects it found, none of which tests could

Every one of these passes a full test suite on both platforms.

**1. `install.sh` demanded `podman` unconditionally.** The quadlet exists to run
Postgres locally; a `DATABASE_URL` pointing elsewhere means the operator already
has one. The check refused an install that would have worked. It is now decided
from the config: a local URL requires podman and installs the quadlet, a remote
one installs neither and says so. `laneward.service`'s
`Requires=laneward-db.service` is a substituted placeholder for the same reason —
a unit that requires a container nobody installed never starts.

**2. Both units exited 127.** A systemd user service does not inherit the login
shell's `PATH`, and `bun` lives under `$HOME`. Addressing bun absolutely in
`ExecStart` was not enough: `run start` executes a package script that invokes
bare `bun`. The fix is `Environment=PATH=` including bun's directory rather than
a rewritten `ExecStart`, because the lane checks spawn whatever a project
declares — `bun test` among them — and need it on `PATH` too.

**3. `PORT` and `HUB_URL` could disagree silently.** Setting `PORT=8799` moved
the API and left the conductor defaulting to `8787`. The only symptom was
`drain pass failed: Unable to connect` every interval, forever. `defaultConfig`
now derives the default hub address from `PORT`, with `HUB_URL` still the
override.

Defect 3 also produced the first field evidence for Stage 5a's error tolerance:
the conductor logged the failure every two seconds and kept looping instead of
dying, which is exactly why a failed pass was made non-fatal.

## Cleaned up

Both units stopped and removed, `daemon-reload` run, `~/.config/laneward`,
`~/.local/share/laneward` and `~/.local/state/laneward` deleted, the three lane
worktrees deleted, and `laneward_a2` dropped. `systemctl --user list-unit-files`
lists no laneward units. Nothing was left running.

## What this does and does not establish

**Establishes:** Laneward installs from `install.sh`, runs as two systemd user
services, dispatches and completes a lane with no human attached, records its
evidence, enforces path ownership unattended, and stops cleanly with its lanes
handed back.

**Does not establish:** that a real Codex worker behaves under a service, as
distinct from under a hand-run conductor, which it has; that
any of this survives a reboot or a logout without `loginctl enable-linger`; that
the quadlet database path works, since an external database was used; or
anything at all about Windows, where the Scheduled Task has been registered but
never run.
