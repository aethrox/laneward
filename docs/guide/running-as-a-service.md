# Running as a service

Both installers stage the app atomically, validate the `.env` they will actually
load, refuse legibly when a prerequisite is missing, and print exactly what they
did not do. Both take `--uninstall`.

!!! warning "Neither platform has survived a reboot or a logout"

    On Linux the units stop at logout unless lingering is enabled, a persistent
    host change the installer deliberately does not make for you. On Windows the
    logon trigger is registered but has never fired from a real logoff and
    logon. This is the honest state of it; see the
    [evidence notes](../notes/2026-08-21-logout-and-linger.md).

## Linux

```bash
./install.sh
```

It installs `laneward.service` and `laneward-conductor.service` as systemd user
units, and, when `DATABASE_URL` points at this host, a `laneward-db.container`
Quadlet with its own `pgdata` volume. Point `DATABASE_URL` at a PostgreSQL you
already run and it installs neither and says so.

Configuration goes to `$XDG_CONFIG_HOME/laneward/.env` (mode 600), the app to
`$XDG_DATA_HOME/laneward/app`, the database volume to
`$XDG_DATA_HOME/laneward/pgdata`. On first run the installer copies
`.env.example` and tells you to edit it before starting anything. It then reads
that file and refuses to continue on an empty `DATABASE_URL`, a non-numeric
`PORT` or `MAX_ACTIVE_LANES`, an agent that is neither declared as a preset nor
as a raw template, or a missing `notify-send` while notifications are on.

Nothing is started for you:

```bash
systemctl --user start laneward-db.service laneward.service
cd ~/.local/share/laneward/app
bun --env-file=~/.config/laneward/.env run db/migrate.ts
systemctl --user start laneward-conductor.service
journalctl --user -u laneward.service -u laneward-conductor.service -n 30
```

The deployed app directory has no `.env` of its own: only the unit reads the one
in the config directory, so every command you run by hand from there needs
`--env-file`.

To survive logout:

```bash
loginctl enable-linger $USER
```

That is a persistent change to the host, which is why the installer names it and
leaves it to you.

`./install.sh --uninstall` stops and disables the units and removes them, and
keeps your `.env` and the `pgdata` volume unless you tell it to purge, in which
case it says exactly what it destroyed.

## Windows

Needs a running Podman machine for the database.

```powershell
.\install.ps1
```

It registers two scheduled tasks at logon: `laneward-conductor-hub` serves the
API and the dashboard, `laneward-conductor` runs the conductor loop.
Configuration goes to `%APPDATA%\laneward\.env`, the app and the database volume
to `%LOCALAPPDATA%\laneward`.

Again, nothing is started and nothing is verified:

```powershell
podman machine start
cd $env:LOCALAPPDATA\laneward\app
bun --env-file=$env:APPDATA\laneward\.env run db:migrate
bun --env-file=$env:APPDATA\laneward\.env run start
Start-ScheduledTask -TaskName laneward-conductor
Get-ScheduledTaskInfo -TaskName laneward-conductor
```

An exit code alone proves nothing here: watch a lane actually run.

!!! danger "Stopping the task strands every running lane"

    Windows has no catchable `SIGTERM`, so unlike the Linux unit the conductor
    cannot hand its lanes back. They are left `running` with no worker behind
    them, which is the same state a crash leaves. Recover with:

    ```powershell
    cd $env:LOCALAPPDATA\laneward\app
    bun --env-file=$env:APPDATA\laneward\.env run reset-stranded --dry-run
    bun --env-file=$env:APPDATA\laneward\.env run reset-stranded
    ```

## What is actually verified

**Linux** installs, runs as two user services, completes a lane unattended,
enforces path ownership with nobody watching, and stops cleanly with its lanes
handed back. The shipped database container starts from its Quadlet, takes the
migration, and its volume survives a restart of the unit. That evidence comes
from a privileged container sharing the host kernel, not from bare metal or a
virtual machine.

**Windows** installs, runs as a scheduled task, and completed a lane driven by a
real agent with nobody attached. Stopping the task mid-lane strands the lane and
`reset-stranded` recovers it, verified as a round trip.

**Neither** has survived a reboot or a logout. Docker, macOS and other service
setups are untried.
