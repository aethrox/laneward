# The database container the package ships, run

S2.4 from the shipping plan, run on 2026-08-19 at
`827dc67`. The plan called it *"the highest-risk untested path on the page,
precisely because it is the default one"*: `quadlet/laneward-db.container` and
its `pgdata` volume are what a new user gets, because they will not already have
a Postgres, and nothing had ever started them. D-014 was demonstrated against an
external database.

## The Linux host, and why it is a container

This machine's WSL cannot run any systemd user manager
([the S3 note](2026-08-19-s3-windows-end-to-end.md) records the failure), and the
Podman machine itself holds the live `laneward-postgres` volume, so it is not
somewhere to install things. The host is therefore a throwaway
`registry.fedoraproject.org/fedora:44` container with systemd as PID 1,
`--systemd=always --privileged`, a non-root `lane` user with linger enabled, and
podman inside it. `systemctl --user` works there, which is the whole requirement.

Two things had to be fixed in the container, and **neither is a Laneward
defect**. The Fedora base image ships no systemd, and nested rootless podman
needs `cap_setuid`/`cap_setgid` file capabilities on `newuidmap`/`newgidmap`;
without them every `podman run` fails with `cannot set up namespace`. Both are
properties of running podman inside podman.

## The result

```
./install.sh                     units, quadlet, config, app, pgdata
systemctl --user start laneward-db.service      active   <- first time ever
systemctl --user start laneward.service         active
bun --env-file=... run db/migrate.ts            Applied 28 statements.
systemctl --user start laneward-conductor.service
                                 conductor loop started, draining every 5000 ms
                                 s24-notes: started
                                 s24-notes: completed
```

`podman ps` inside the host reported
`laneward-db | Up | 127.0.0.1:5433->5432/tcp`, exactly what the quadlet declares.
The lane's `notes.txt` carried the requested line, `git status` showed the one
file it owned, and the evidence row recorded `overall: not_configured` for a
repository that declares no checks.

**The volume persists.** `pgdata` reached 46.3 MB, `systemctl --user restart
laneward-db.service` brought the container back, and the hub reconnected on its
own with the lane history intact. That is the claim the `pgdata` volume exists to
make, and it had never been checked.

## Two other paths closed in the same sitting

**The declared agent, on Linux.** The worker was a `LANEWARD_AGENT_WRITE` JSON
argument array pointing at a script that takes `--workdir` and `--model` and
knows no Codex flag. S2b's adapter had run under the Windows Scheduled Task and
in the test suite; this is its first run under systemd.

**`install.sh --uninstall` after a real install.** It had only ever been run
after a dry one. It removed the units, the quadlet's container and the app
directory, and kept `~/.config/laneward/.env` and `pgdata` while saying so,
which is the behaviour the flag promises and the reason it is not `--purge` by
default.

## What this does not establish

- **A real Codex worker under systemd.** Deliberately not attempted: it would
  have meant putting Codex credentials into a throwaway container. A real Codex
  worker has now run under the Windows Scheduled Task
  ([notes](2026-08-19-s3-windows-end-to-end.md)); under systemd it is still the
  fixture-or-declared-agent story.
- **Reboot and logout** (S4.2). Linger is enabled in the container by
  construction, so nothing was learned about the case where it is not.
- **A bare-metal or VM Linux host.** Everything above is inside a privileged
  container on a Podman machine on Windows. The systemd user manager, the
  quadlet, the volume and the units are real; the kernel is shared with the
  host, and the two nesting fixes above would not be needed elsewhere.

## Cleaned up

The container and its image were removed. Nothing was installed on the Podman
machine or on this Windows host, and `laneward-postgres` was not touched.
