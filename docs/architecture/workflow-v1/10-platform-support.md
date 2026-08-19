# Platform Support

Laneward targets Windows and Linux. Both are first-class: a change is not
complete until it works on both.

macOS is explicitly out of scope. Code should not be made deliberately
macOS-hostile, but no macOS path is designed, documented, or verified, and a
macOS gap is not a defect.

Decided 2026-08-07. This supersedes the open question in
a portability survey that D-022 and D-023 superseded.

## What "first-class" requires

The approved decisions already set the bar. D-014 says approved lanes continue
after Claude exits, and D-015 says Laneward starts automatically. Neither
decision is conditional on the operating system, so both platforms need a real
answer for every layer below, not just Linux.

## The four layers

### 1. Application layer

`index.ts`, `conductor.ts`, the dashboard, and the test suite are Bun and
TypeScript. They already run on both platforms. No work is required beyond
keeping them free of Linux-only assumptions: no hardcoded `/` path joins, no
assumption that `sh` exists, no reliance on POSIX signals.

### 2. Scripts

Done as of 2026-08-15. `scripts/new-lane.ts`, `scripts/check-evidence.ts` and
`scripts/codex-round.ts` were Bash and depended on `jq` and `curl`, which meant
they did not run under PowerShell at all.

They are now TypeScript. `jq` and `curl` are replaced by Bun's own JSON handling
and `fetch`, and shell calls to `git` by `Bun.spawn` with argument arrays rather
than interpolated command strings. This removed the Bash, `jq` and `curl`
dependencies entirely rather than adding a second PowerShell copy of each
script.

Argument arrays are not a style preference here. Paths on this machine contain
spaces, and a string-interpolated command is where that becomes a defect.

### 3. Database runtime

PostgreSQL is provisioned as a Podman quadlet on Linux. That path stays and
remains the verified one.

Settled by D-037 on 2026-08-15: Windows runs the same container image on a
Podman machine with the port published on `127.0.0.1`. One container definition,
two ways of starting it, rather than a second engine folded into the quadlet.
The README's Limitations section states which paths are verified and which are
best effort, per platform, and does not claim more than has been observed.

Not yet built: nothing installs or checks the Podman machine on Windows, and the
machine does not survive a reboot on its own.

### 4. Service and persistence layer

This is the layer where the platforms genuinely differ, and it cannot be
skipped on Windows without breaking D-014 and D-015.

- Linux: systemd user units, with `loginctl enable-linger` where the service
  must survive logout. `laneward.service` serves the API and the notifier;
  `laneward-conductor.service` runs `conductor.ts --loop`, which is the unit
  that makes D-014 true. Both are installed by `install.sh` as of 2026-08-15,
  and neither has been started.
- Windows: a Scheduled Task at logon, settled by D-038 on 2026-08-15. Not built.

Note what D-038 concedes rather than solves. Windows has no POSIX signal
delivery, so no supervision mechanism there can stop the conductor cleanly; a
stop terminates the process and leaves lanes `running` with no worker behind
them, recovered by `scripts/reset-stranded.ts` exactly as after a crash. That is
CP-3's cost, and it is paid at the service layer rather than avoided by choosing
a different tool.

`install.sh` is Linux-only by nature. Windows gets its own installer rather
than a portability shim inside the Bash one.

## Codex on the Windows host

Codex's Windows sandbox has a mode setting, `[windows] sandbox`, accepting
`elevated` or `unelevated`. This host must use `unelevated`.

Under `elevated`, Codex switches to a separate local account per command through
`CreateProcessWithLogonW`. Those accounts exist here but have no Windows
profile, so every command fails before starting with error 2, and file writes
fail as well. Under `unelevated` it uses a restricted token instead and works.

This is a host configuration fact, not a Laneward design constraint, but it is
recorded here because it cost a day and because `codex doctor` reports the
sandbox as healthy while it is failing. Details and upstream issue links are in
[../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md](../../notes/2026-08-07-codex-sandbox-and-git-boundary-probe.md).

The episode is also the argument for D-023. Repairing the sandbox required
briefly running Codex with `danger-full-access`, meaning no confinement at all.
A safety property that can vanish because of one configuration value is not one
the architecture should rest its Git boundary on, even though the repaired
sandbox does enforce that boundary well.

## Consequence for the Codex Git boundary

With the sandbox working, the Phase 2 probe ran and found that
`workspace-write` already denies every Git mutation from a lane worktree: the
object store lies outside the writable workspace, so Git cannot write its lock
file. Read commands still work, which is the behavior D-008 wants.

The mechanism is a property of linked worktrees rather than of Windows, so the
same denial is expected on Linux under Landlock. Expected is not measured, and
per D-022 both platforms need their own evidence before Phase 2 closes.

## Known unknowns

- Linux is measured by the suite, not by operation. On 2026-08-15 the full suite
  ran under WSL at 275 pass, 0 fail, including `tests/git-guard.test.ts` and the
  SIGINT test Windows skips ([notes](../../notes/2026-08-15-linux-suite-run.md)).
  What that does not establish: no lane has been driven end to end on Linux, and
  no installation, service or notification path has been exercised there. Note
  that WSL is Linux: using it validates the Linux path, and does nothing for the
  native Windows path that D-022 also requires.
- Whether Laneward is developed on Windows and deployed to a Linux host, or run
  standalone on each, is no longer an open architectural question: both must
  work. It remains an operational choice per installation.
