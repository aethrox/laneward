# A real agent under systemd

The last seam this project had never observed. Under systemd every lane so far
had been driven by a fixture or by a declared test agent
([D-014](2026-08-15-d014-demonstrated.md),
[the shipped database container](2026-08-19-s24-shipped-database-container.md)),
and both notes list a real worker under a service as the thing they do not
establish. It is now established, with the `claude` preset.

Run on 2026-08-20 at `a4f08ee`, unmodified.

## The host

The same shape as S2.4: a throwaway `registry.fedoraproject.org/fedora:44`
container with systemd as PID 1, `--systemd=always --privileged`, a non-root
`lane` user with linger, podman inside it, and the two nesting fixes that are
properties of podman-in-podman rather than Laneward defects. Fedora 44, bun
1.3.14, `@anthropic-ai/claude-code` 2.1.237.

The database was the one the package ships: `laneward-db.container` on
`127.0.0.1:5433` with its own `pgdata`, started by the quadlet.

The agent's credentials were placed in `/home/lane/.claude`, which is the whole
reason this became possible. `buildWorkerEnv` strips every variable matching
`_API_KEY$`, so an API key never reaches the worker; a profile directory does.
The same fact is what had blocked the Codex version of this run, since that one
would have meant putting an API credential somewhere the strip removes it from.

## The result

```
09:23:37  conductor loop started, draining every 5000 ms
09:24:0x  lane systemd-claude registered through the API
09:24:17  systemd-claude: started
09:24:29  systemd-claude: completed
```

Forty seconds of idle loop, then the conductor picked the lane up on its own,
spawned `claude` under `laneward-conductor.service` with no terminal and the
stripped environment, and recorded the result. Nothing was attached.

The lane owned `notes.txt` and the worker wrote exactly it:

```
notes
driven by a real agent under systemd

git status --porcelain -uall   ->    M notes.txt
```

The evidence row recorded `overall: not_configured`, which is correct for a
repository that declares no checks, and the lane log holds the agent's own
sentence rather than a fixture's.

## What the guard log shows

Nine refusals, every one of them `read_intent: true`, so
`check-evidence` counted them and passed: only a non-read refusal fails a lane.

They are worth reading, because they are the agent orienting itself rather than
the agent trying to move anything:

```
git ls-files --error-unmatch -- :(icase).claude/settings.local.json
git remote get-url origin
git config user.name
git --no-optional-locks status --short
git --no-optional-locks log --oneline -n 5
git log --since=7.days --diff-filter=A --name-only -- .claude/skills .claude/commands
git -C /home/lane/driven worktree list --porcelain
```

`--disallowedTools "Bash(git *)"` in the preset does not stop these, and was
never going to: they are the agent's **internal** Git calls, not its Bash tool.
The preset comment says denying the calls at the agent is the fix for the lane
failing, and that remains true for the tool-driven ones, but the internal set
still arrives at the shim on every run. It is survivable by construction, since
all of them are reads. A future agent whose internal Git use includes a write
would fail a lane for a reason its operator could not have predicted from the
preset.

## What this does not establish

- **Bare metal or a VM.** Same caveat as S2.4: real systemd, real podman,
  shared kernel.
- **Reboot and logout.** Linger is enabled in the container by construction.
- **The `codex` preset under systemd.** Still deferred, and now for the same
  credential reason plus the absence of a subscription on this machine.

## Cleaned up

`install.sh --uninstall --purge`, then the container and its image removed. The
credentials copy went with the container. Nothing was installed on the Podman
machine or on the Windows host, and `laneward-postgres` was not touched.
