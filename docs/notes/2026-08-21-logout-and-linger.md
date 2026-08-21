# Logout, with and without linger

`install.sh` ends by saying that the services stop at logout unless
`loginctl enable-linger` is set. It has said that since the first Linux install
and nobody had tested it, which made it the last documented claim on this
project resting on nothing but systemd's manual page.

Run on 2026-08-21 at `8bd46ad`, unmodified, in a throwaway Fedora 44 container
with systemd as PID 1 and no linger enabled by construction, which is the one
difference from the host the earlier Linux runs used.

## Both halves

A real logind session was opened with `machinectl shell`, all three units
started inside it, and the **session** closed. The claim holds in both
directions:

```
Linger=no    session closed -> user@1000 inactive
                               laneward-db, laneward, laneward-conductor all gone
                               no bun processes, /run/user/1000 removed

Linger=yes   session closed -> user@1000 active
                               all three units active
                               hub answers HTTP 200 with nobody logged in
```

The nested database container goes down with the user manager in the first case,
because Quadlet's unit is a user unit like the others. Nothing survives, and
nothing is left half-running.

## The trap this run walked into first

The first attempt used `loginctl terminate-user`, and everything stopped **with
linger enabled**, which read as the claim being false. It is not: `terminate-user`
ends the user's manager regardless of linger, so it answers a different question
than a logout does. Only `terminate-session` reproduces what a person leaving
their desk does.

That is worth knowing beyond this run. An operator who tests their own linger
setup with `terminate-user`, or a session manager that calls it, will conclude
that linger does not work.

## The stop is clean

At logout the conductor received `SIGTERM` and logged its hand-back line before
the unit stopped:

```
SIGTERM received - stopping 0 running lane(s)
Stopped laneward-conductor.service - Laneward conductor.
```

Zero lanes were running, so this does not establish that a lane in flight is
handed back at logout; it establishes that the same shutdown path D-014 observed
under an explicit `systemctl --user stop` is the one a logout takes.

One cosmetic thing to expect in the journal, since it looks worse than it is:

```
bun: error: script "start" was terminated by signal SIGTERM (Polite quit request)
```

That is bun's run-script wrapper reporting how its child ended, not a failure of
the unit.

## What this does not establish

- **A lane in flight at logout.** Nothing was running.
- **A cold boot.** Neither platform has been rebooted. Windows still has that
  half of the item ([the logon trigger run](2026-08-20-windows-logon-trigger.md)
  was a logoff and logon, not a boot).
- **Bare metal.** Same caveat as every Linux run here: real systemd, real
  podman, shared kernel.

## Cleaned up

The container and its image were removed. Linger was enabled and disabled inside
that container only; nothing on the Podman machine or the Windows host was
changed.
