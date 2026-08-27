# Safety and limits

What Laneward protects you from, what it does not, and what has actually been
verified. Read this before you point it at a repository that matters.

## The two things that will surprise you

**No authentication, ever.** The hub listens on `127.0.0.1` and that address is
hardcoded, not configured. Anything that can reach the port can register lanes,
resolve approvals and read every brief. It is built for one trusted single-user
machine. Do not put it behind a tunnel and call it done.

**Each lane worktree gets a copy of the driven repository's `.env`.** The agent
can read your real secret values: API keys, tokens, whatever is in there. Only
`DATABASE_URL` is rewritten, to a database created for that lane. Redaction is
not implemented, and this is the largest known gap in the system.

If that is unacceptable for a given repository, the honest answer today is not
to drive that repository with Laneward.

## What the agent does not get

The conductor builds the agent's environment rather than handing over its own.
It removes:

- `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_API_TOKEN`
- `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GIT_SSH`,
  `GIT_SSH_COMMAND`
- `DATABASE_URL`, so the lane reads its own from its own `.env`
- anything whose name ends in `TOKEN`, `PASSWORD`, `PASSWD`, `SECRET`,
  `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `ASKPASS` or `AUTH_SOCK`
- every `GIT_DIR`-family variable that could redirect git at another repository

and sets global and system git config to `/dev/null` (`NUL` on Windows),
`GIT_TERMINAL_PROMPT=0`, and a throwaway `GH_CONFIG_DIR`.

What remains readable is the repository's own local git config, including the
remote URL. That is a known exposure, not an oversight.

## The git boundary

Laneward owns git. It places a shim first on the agent's `PATH`, so every `git`
call the agent makes goes through it.

Permitted: `status`, `diff`, `log`, `show`, `rev-parse`, `rev-list`, `ls-files`,
`ls-tree`, `cat-file`, `blame`, `describe`, `grep`, `show-ref`, `for-each-ref`,
`merge-base`, `diff-tree`, `diff-index`, `shortlog`, `name-rev`, plus `branch`,
`worktree` and `stash` as pure listings, plus `git --version`.

Refused outright, before the subcommand is even considered: `-c`,
`--config-env`, `--exec-path`, `--upload-pack`, `--receive-pack`, `--namespace`.
Each of those can turn a read into arbitrary execution.

A refusal prints one line and exits 86:

```
REFUSED: git commit is not permitted. Laneward owns Git.
```

and appends a line to `<lane_id>.git-guard.jsonl` recording the arguments and
whether the call looked like a read. After the run, a refused **mutation** fails
the lane; a refused **read** is reported and the lane still passes.

!!! note "The shim is defence in depth, not the only control"

    A sandboxed agent usually denies these calls itself. The shim exists because
    that sandbox was once observed absent for hours on this host. Treat it as
    the second line, not the first.

## Known gaps, stated plainly

- **Secrets.** The `.env` copy above.
- **No authentication**, `127.0.0.1` only, single user by design.
- **Multi-conductor operation is unsafe** and nothing enforces a single one. Two
  conductors against one database will fight over the same lanes.
- **Git exposure.** The repository-local git config, including the remote URL,
  is readable from inside a lane worktree.
- **No vulnerability reporting channel.** There is no `SECURITY.md` and
  GitHub-level hardening is not configured.
- **`reset-stranded` resets every running lane.** It cannot distinguish a
  stranded lane from a healthy one.
- **The test suite truncates whatever `DATABASE_URL` points at.** It refuses any
  database whose name does not end in `_test` or start with `laneward_lane_`,
  which is the only thing standing between a careless export and your lane
  history.

## What is verified, and what is not

**Linux.** Installs, runs as two systemd user services, completes a lane
unattended, enforces path ownership with nobody watching, and stops cleanly with
its lanes handed back. The shipped database container starts from its Quadlet,
takes the migration, and its volume survives a restart of the unit. That
evidence comes from a privileged container sharing the host kernel, not from
bare metal or a virtual machine.

**Windows.** Installs, runs as a scheduled task, and completed a lane driven by
a real agent with nobody attached. Stopping the task strands the lane, and
`reset-stranded` recovers it, verified as a round trip.

**Neither platform** has survived a reboot or a logout. The Windows logon trigger
has never fired from a real cycle. A real agent has run under the Windows task
but never under systemd. Docker, macOS and other service setups are untried.

The [evidence notes](../notes/2026-08-19-what-is-left.md) record what was run,
what it found, and, in each case, what it did not establish.

## What a green lane does and does not mean

`completed` means the agent exited 0, every dirty path in its worktree was
inside `owned_paths`, and the checks the driven repository declares passed. It
does **not** mean the work is correct, reviewed, committed or merged. Reading the
diff is still your job, and commit and merge stay manual by design.
