# Install and first run

A hub and a conductor run on one machine, from a clone. Nothing here is
installed as a service; that is
[Running as a service](running-as-a-service.md).

## What you need first

| Requirement | Notes |
|---|---|
| [Bun](https://bun.sh) 1.3.14 | Both installers warn below this, and it is the version everything here was verified against. Newer is not safe: on Bun 1.4.0 under Windows, `scripts/teardown.ts` exits 0 having removed nothing and printed nothing. CI pins 1.3.14 for that reason. |
| git | Verified on 2.54.0. |
| PostgreSQL 16 | Any reachable instance. On Linux with rootless Podman, `install.sh` can bring its own. |
| An agent CLI | Codex 0.147.0 or newer for the `codex` preset — last verified against a real run on 2026-08-19 and now covered by tests rather than by a run, since that subscription lapsed — Claude Code for the `claude` preset, or any command of your own. See [Configuration](configure.md). |

Desktop notifications work on Linux (`notify-send`) and Windows (a PowerShell
toast). macOS gets no notifications; everything else still runs.

## Clone and configure

```bash
git clone https://github.com/aethrox/laneward.git && cd laneward
bun install
cp .env.example .env
```

Now edit `.env`. Two values matter before anything will run:

```bash
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward
LANEWARD_AGENT=claude     # or codex, or declare LANEWARD_AGENT_WRITE instead
```

!!! warning "The port in `.env.example` is 5433, not 5432"

    That is the port the shipped Podman container publishes. A PostgreSQL you
    already run almost certainly listens on 5432, and the symptom of getting
    this wrong is a connection refused on the first command, not a helpful
    error later.

With neither `LANEWARD_AGENT` nor `LANEWARD_AGENT_WRITE` set, the hub and the
migration still work; the first lane is what fails, with a refusal naming both
ways to declare an agent.

## Create the schema

```bash
bun run db:migrate
```

It prints `Applied N statements.` and is safe to re-run: the schema file is a
list of additive `CREATE ... IF NOT EXISTS` and `ALTER ... IF EXISTS`
statements.

If `DATABASE_URL` is unset you get exactly this, and nothing is touched:

```
DATABASE_URL is not set: copy .env.example to .env
```

## Start the hub

```bash
bun run start
```

The dashboard is at [http://127.0.0.1:8787](http://127.0.0.1:8787). It is empty
until you register a lane. `bun run dev` is the same thing with hot reload,
which is useful while reading the code and pointless while driving lanes.

The hub listens on `127.0.0.1` only, and that address is hardcoded rather than
configurable. `PORT` moves the port; the conductor derives its own hub address
from `PORT` unless you set `HUB_URL`.

## Start the conductor

In a second terminal:

```bash
bun run conductor          # one drain pass, then a printed summary
bun run conductor --loop   # keep draining every 5 seconds
```

A single pass exits non-zero if any lane failed or errored, which makes it
usable from a script. `--loop` never returns and never prints a summary; it is
what a service unit runs.

!!! warning "Run the conductor through the package script"

    `bun run conductor` is `bun --env-file=.env run --no-env-file conductor.ts`.
    Both flags carry weight, in that order: the first loads the `.env` beside
    the checkout, which is where `LANEWARD_AGENT` lives, and the second stops
    Bun auto-loading a second `.env` from whatever directory you happen to be
    in. Calling `bun run conductor.ts` directly loads neither, and the first
    lane fails with `no agent preset is active`.

    What keeps Laneward's own `PORT` and `DATABASE_URL` out of a spawned agent
    is not the flag but the worker boundary: the conductor strips both, along
    with the host's Git, GitHub and SSH credentials, from the environment it
    hands each agent. `PORT` is stripped because a lane that inherits it serves
    its own repository on the hub's port.

Start both detached rather than as background jobs of a tool session. A
conductor killed mid-lane leaves an orphaned agent writing into a worktree that
nothing is scoring.

## Check that it is actually up

```bash
curl -s http://127.0.0.1:8787/pending
curl -s http://127.0.0.1:8787/lanes
```

A fresh install answers:

```json
{"waiting_approval":[],"failed":[],"findings":[]}
```

`GET /pending` is your one "what needs me" query. The desktop notifier and the
Claude Code bridge read the same thing.

## Running the test suite

Point `DATABASE_URL` at a **separate** database whose name ends in `_test`
before running `bun test`. The suite truncates the tables it finds:

```bash
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward_test bun run db:migrate
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward_test bun test
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward_test bun run typecheck
```

Anything else is refused before the first statement runs:

```
refusing to run tests against laneward: the suite truncates lanes, messages and
approvals. Point DATABASE_URL at laneward_test, a name ending in _test, or a
laneward_lane_* database.
```

## Next

[Configuration](configure.md) is the next step: declaring which agent runs, and
what each model tier means.
