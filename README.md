# Laneward

Laneward runs several coding agents on one repository at the same time, each in its own git worktree, and keeps them from colliding. Approved work continues after you close your editor.

[![CI](https://github.com/aethrox/laneward/actions/workflows/ci.yml/badge.svg)](https://github.com/aethrox/laneward/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

It does not plan work and it does not write code. You or your editor decide what needs doing; Laneward records each task, decides when it is safe to start, spawns the agent, checks what it touched, and shows the result on one screen.

A unit of work is called a **lane**. A lane owns a set of file paths, a worktree, a branch, and a database of its own. Two lanes that claim the same path cannot run at the same time, and Laneward is what enforces that.

> [!IMPORTANT]
> Two things to know before you install, not after.
>
> Laneward listens on `127.0.0.1` with **no authentication**. It is built for one trusted single-user machine. Do not expose it.
>
> Each lane's worktree receives a **copy of the driven repository's `.env`**, so an agent can read your real secret values. Only `DATABASE_URL` is rewritten, to a database created for that lane. Redaction is not implemented.

**[The documentation site](https://aethrox.github.io/laneward/)** is where the detail lives: how the pieces fit together, every configuration variable, writing briefs, daily operation, the API, and what has actually been verified. This page is the short version.

## Project status

**Development has stopped, and the reason is money rather than interest.**

Laneward exists to drive commercial coding agents, and every hour of work on it costs agent subscriptions on top of the time. I cannot currently fund that, so the project stops here rather than drifting into a repository that looks maintained and is not.

It works, and what works was measured rather than assumed. Lanes run unattended under a systemd user service and under a Windows Scheduled Task, driven by a real agent, and [docs/notes](docs/notes) records each run including what it failed to establish. The known gaps are documented rather than fixed: [Limitations](#limitations) is the honest list, and [what is left](docs/notes/2026-08-19-what-is-left.md) is the work that was planned and not done. Issues and pull requests may go unanswered, so do not wait on me. The licence is MIT, so fork it and take it somewhere.

If you are looking for something to run in production, this is not it. If you are looking for a working design to read, take apart, or continue, that is exactly what is here.

## Quick start

Needs [Bun](https://bun.sh) 1.3.14, git, and a PostgreSQL you can reach. Bun 1.4.0 breaks teardown on Windows, so 1.3.14 is what CI pins and what this was verified against. On Linux with rootless Podman, `install.sh` brings its own database.

```bash
git clone https://github.com/aethrox/laneward.git && cd laneward
bun install
cp .env.example .env          # edit DATABASE_URL, and set LANEWARD_AGENT
bun run db:migrate
bun run start                 # dashboard on http://127.0.0.1:8787
```

There is no default agent. Set `LANEWARD_AGENT=codex` or `LANEWARD_AGENT=claude` in `.env`, or give `LANEWARD_AGENT_WRITE` a raw command array instead; the first lane fails with a refusal until one is declared. Every variable there is, and both shipped presets, are in [Configuration](https://aethrox.github.io/laneward/guide/configure/).

In a second terminal, register a lane against a repository you want worked on and let the conductor pick it up:

```bash
LANE_REPO=/path/to/your/repo bun scripts/new-lane.ts fix-login brief.md src/auth
bun run conductor --loop
```

`brief.md` is the instruction the agent reads on stdin. `src/auth` is the only path this lane may touch; anything else it writes fails the lane. [Your first lane](https://aethrox.github.io/laneward/guide/first-lane/) walks the same thing through end to end.

## What it does today

- Records lanes, plans, plan revisions, approvals and evidence in PostgreSQL.
- Creates a worktree, a branch, and a per-lane database for each lane, with the driven repo's own `db:migrate` applied to it.
- Refuses to register a lane whose `owned_paths` overlap a lane that is not finished, and enforces `depends_on`, a concurrency ceiling, and plan-revision authority.
- Spawns any agent that reads a brief on stdin and signals with its exit code, retrying a failing lane up to three attempts.
- Scores every dirty path in the worktree against `owned_paths` and fails the lane on a violation.
- Runs the checks the driven repository declares and records their results as evidence.
- Runs an advisory read-only reader over a completed plan revision, and builds an integration candidate at the end of a drain pass.
- Sends desktop notifications for the events that block work.
- Hands running lanes back on `SIGTERM`, and recovers stranded ones with `reset-stranded`.
- Installs as a supervised service on Linux (systemd user units plus a Quadlet database) and Windows (a Scheduled Task at logon).

A lane that reaches `completed` exited 0, touched only what it owned, and passed the checks its repository declares. That does not mean the work is correct, reviewed, committed, or merged. Commit and merge stay manual by design.

## What it does not do

- Plan work, split it into lanes, or write briefs.
- Commit, merge, push, or open pull requests. All four are deliberately manual.
- Redact secrets from the `.env` it copies into a lane worktree.
- Prevent a second conductor from running against the same database.
- Authenticate anything, or serve anywhere but `127.0.0.1`.

## Installation

Both installers stage the app atomically, validate the `.env` they will actually load, refuse legibly when a prerequisite is missing, and print exactly what they did not do. Both take `--uninstall`.

```bash
./install.sh     # Linux: two systemd user units, plus a Quadlet database when DATABASE_URL is local
```

```powershell
.\install.ps1    # Windows: a laneward-conductor Scheduled Task at logon, against a Podman machine
```

> [!WARNING]
> Neither platform has survived a reboot yet. Logout is settled: on Linux the units stop at logout unless `loginctl enable-linger` is enabled, a persistent host change the installer deliberately does not make for you, and with it they all stay up (2026-08-21). On Windows the logon trigger has fired from a real logoff and logon (2026-08-20).

The post-install commands, the `--env-file` every Windows invocation needs, and what to do when a stopped task strands a lane are in [Running as a service](https://aethrox.github.io/laneward/guide/running-as-a-service/).

## Limitations

**Linux.** Installs, runs as two systemd user services, completes a lane unattended, enforces path ownership with nobody watching, and stops cleanly with its lanes handed back. The shipped database container starts from its Quadlet, takes the migration, and its volume survives a restart of the unit. That evidence comes from a privileged container sharing the host kernel, not from bare metal or a VM.

**Windows.** Installs, runs as a Scheduled Task, and completed a lane driven by a real agent with nobody attached. Stopping the task mid-lane strands the lane and `reset-stranded` recovers it, verified as a round trip.

**Neither platform** has survived a reboot. Logout is settled in both directions: on Linux the units stop without linger and stay up with it (2026-08-21, measured in a privileged container rather than on bare metal), and on Windows the logon trigger has fired from a real logoff and logon (2026-08-20). A real agent has run unattended under both the Windows task and systemd. The `codex` preset itself has not run under systemd, and stayed deferred once its subscription lapsed. Docker, macOS, and other service setups are untried.

The `.env` copied into each lane worktree is the largest remaining gap: only `DATABASE_URL` is rewritten. Beyond that there is no authentication, multi-conductor operation is unsafe and nothing enforces a single conductor, the repository-local git config including the remote URL is readable from inside a lane worktree, and there is no `SECURITY.md` or vulnerability reporting channel. [Safety and limits](https://aethrox.github.io/laneward/guide/safety-and-limits/) is the full account.

## More information

- [The MCP server](https://aethrox.github.io/laneward/guide/mcp-server/): hands Laneward to your own coding agent as a set of tools, alongside the [Claude Code bridge](https://aethrox.github.io/laneward/guide/claude-code-bridge/) hook
- [Documentation site](https://aethrox.github.io/laneward/): the guide, the glossary, the architecture and the evidence notes, navigable and searchable. The guide is bilingual, English and Turkish, and lives in [docs/guide/](docs/guide/)
- [Workflow v1 target architecture](docs/architecture/workflow-v1/README.md), including the decision log every `D-0NN` reference points at
- [Evidence notes](docs/notes/): what was run, what it found, and what it did not establish
- [AGENTS.md](AGENTS.md) and [docs/agents/](docs/agents/): what the `doctrine` skills read to learn this repo's conventions

## License

MIT. See [LICENSE](LICENSE).
