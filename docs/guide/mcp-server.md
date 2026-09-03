# The MCP server

`mcp.ts` hands Laneward to your own coding agent as a set of tools. The agent
registers lanes, watches them, reads their logs and evidence, and brings a
parked lane's question back to you. It is the same hub the dashboard talks to,
over the same HTTP routes; nothing here is a second source of truth.

It speaks newline-delimited JSON-RPC over stdin and stdout, which is what every
MCP client expects of a local server. It is optional, like the bridge, and it is
not a substitute for reading the dashboard.

```bash
bun run mcp
```

That is `bun run --no-env-file mcp.ts`. Run it by hand only to see it start; a
client launches it for you.

## Registering it

### Claude Code

This repository ships a `.mcp.json`, so a session started inside the Laneward
checkout already has the tools:

```json
{
  "mcpServers": {
    "laneward": {
      "command": "bun",
      "args": ["run", "--no-env-file", "mcp.ts"],
      "env": {
        "LANE_REPO": "${LANE_REPO:-}",
        "DATABASE_URL": "${DATABASE_URL:-}"
      }
    }
  }
}
```

Those two values come from the shell that started the client, so export them
before starting it if you want to open lanes from inside this checkout:
`lane_create` needs `LANE_REPO`, `reset_stranded` needs `DATABASE_URL`, and
each refuses by name when its variable is missing. The empty defaults are
deliberate. A bare `${LANE_REPO}` expands to that literal text when the
variable is unset, which passes the server's own check and then fails further
in with something less clear.

The path is relative because a project-scoped server is launched with the
project directory as its working directory. To register it from another
project, give the absolute path:

```bash
claude mcp add laneward -- bun run --no-env-file /path/to/laneward/mcp.ts
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.laneward]
command = "bun"
args = ["run", "--no-env-file", "/path/to/laneward/mcp.ts"]
env = { LANE_REPO = "/path/to/your/repo" }
```

### Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "laneward": {
      "command": "bun",
      "args": ["run", "--no-env-file", "/path/to/laneward/mcp.ts"],
      "env": { "LANE_REPO": "/path/to/your/repo" }
    }
  }
}
```

!!! warning "`--no-env-file` is load-bearing"

    Bun loads `.env` from the current working directory, and an MCP server's
    working directory is the *client's* project rather than Laneward's. Without
    the flag, the driven repository's `DATABASE_URL` is loaded into the server
    and into every script it spawns, and `new-lane.ts` provisions a lane
    database against the wrong server. Every snippet above carries the flag.
    Keep it.

!!! warning "`LANE_REPO` decides which repository lanes open on"

    `lane_create` refuses when `LANE_REPO` is unset, because
    `repositoryLocation()` in `scripts/new-lane.ts` would otherwise fall back to
    Laneward's own checkout and open the lane there. Set it in the client
    configuration, next to the command, and restart the client after changing
    it: the server reads its environment once, at launch.

`HUB_URL` is read the same way the bridge reads it, defaulting to
`http://127.0.0.1:8787`, and every hub request times out after two seconds.
`reset_stranded` additionally needs `DATABASE_URL`, for the reason below.

## The tools

| Tool | Kind | What it does |
|---|---|---|
| `laneward_status` | read | The counts sentence plus `/pending` in full, including each waiting lane's question |
| `lane_list` | read | Every lane with its status and plan revision |
| `lane_gate` | read | Why a lane may or may not run. A closed gate is a success, not an error |
| `lane_log` | read | The tail of a lane's worker log |
| `lane_evidence` | read | What a lane recorded as evidence |
| `plan_show` | read | A plan and every revision, with approval state |
| `findings_list` | read | Verification findings on one plan revision |
| `candidates_due` | read | Plan revisions whose lanes are all complete and which have no candidate yet |
| `lane_create` | write | Registers a lane: worktree, branch, database, row. Runs nothing |
| `plan_submit` | write | Records a plan and its revision 1 |
| `plan_revise` | write | Appends a revision, withdrawing authority from lanes on older ones |
| `lane_answer` | write | Resolves an approval with the human's decision |
| `finding_adjudicate` | write | Accepts, rejects or defers one finding |
| `plan_approve` | **destructive** | Grants execution authority. Cannot be undone |
| `build_candidate` | **destructive** | Builds an integration candidate; `rebuild` destroys the existing one |
| `reset_stranded` | **destructive** | Rewrites lane state unless `dry_run` |
| `lane_teardown` | **destructive** | Drops the lane's database, worktree and branch |

The destructive four are marked twice over, because clients surface the two
channels differently: each carries `annotations.destructiveHint`, and each
description opens with the literal word `DESTRUCTIVE` and tells the agent to
ask you first. `build_candidate` and `reset_stranded` are only destructive on a
flag, and the condition is stated in both the tool description and the
parameter's own.

Every tool answers with a one-sentence summary followed by the payload, so an
agent that reads nothing else still reads what happened. A failure the hub or a
script reports comes back as a tool error rather than a protocol error: the
agent sees the text and can act on it.

## The workflow prompt

The server serves one prompt, `laneward_workflow`, and the same text as
`instructions` in its `initialize` response. It is one string in
`src/mcp-brief.ts` so the two cannot drift. This is it, in full:

---

Laneward runs coding agents on one repository at once, each in its own git
worktree, and keeps them from colliding. You drive it on the human's behalf.
You are not a lane; you register lanes, watch them, and bring what they ask
back to the human.

**Lanes are asynchronous.** `lane_create` returns as soon as the worktree
exists - nothing has run yet. A separate process, the conductor, dispatches
lanes when their gate opens. Poll `lane_list` between other work; do not spin.
Nothing you do makes a lane run sooner.

**owned_paths is the whole collision story.** Every lane declares the paths it
owns. Two lanes that are not finished may not own overlapping paths, and
registration overlap is a prefix match: `src/auth` reserves everything under
it. Scoring is different and stricter - the evidence check is an anchored glob
where `*` does not cross `/`, so a lane touching `src/auth/deep/util.ts` needs
`src/auth/*` and `src/auth/*/*`. Registration fails with HTTP 409 naming the
conflicting lane. Split work along file boundaries before you split it into
lanes. If two pieces of work must touch the same file, they are one lane.

**The brief is everything the worker gets.** It cannot see this conversation,
its plan, or the other lanes. Write: the goal in one sentence, the exact
command whose output proves the work is done, every path it owns including the
test and the doc the change forces, and what it must not touch. Give it the
escalation block: a line starting `APPROVAL REQUIRED:` when the brief is wrong
or ambiguous, a line starting `HOST VERIFICATION REQUIRED:` when the work is
done but a claim could not be checked. Both park the lane instead of guessing.

**The gate closing is not an error.** `lane_gate` returning `allowed: false`
with a reason - unapproved plan revision, unmet dependency, active-lane limit,
owned_paths conflict - is Laneward working. Read the reason and act on it; do
not retry.

**A lane that stops to ask is waiting on a human, not on you.** It appears in
`laneward_status` under `waiting_approval` with its question. Bring the
question to the human in their own words, get an answer, then `lane_answer`
with the approval id and the decision text. The conductor appends your decision
to the original brief and dispatches the lane again.

**Commit and merge stay manual.** Laneward never commits, merges or pushes.
`build_candidate` assembles an integration candidate for review; it is not a
merge. The human integrates.

**Before any tool marked DESTRUCTIVE, ask.** `lane_teardown` destroys a
database, a worktree and a branch. `plan_approve` grants execution authority
and cannot be undone. `reset_stranded` without `dry_run` rewrites lane state.
`build_candidate` with `rebuild` destroys the existing candidate. Say what will
be destroyed, in one sentence, and wait for a yes.

**If the hub is unreachable**, say so and stop. Laneward is a local service on
`HUB_URL`; when it is down, nothing you can call will help. The human starts it
with `bun start`.

---

## What it deliberately does not expose

The tools are a curated subset of the [API](api-reference.md), not a wrapper
around it. Three groups are left out on purpose.

`POST /lanes/:id/start`, `POST /lanes/:id/messages`, `POST /lanes/:id/result`
and `GET /lanes/dispatchable` are the conductor's and the worker's side of the
protocol. A `lane_start` tool would race the conductor for the
`MAX_ACTIVE_LANES` budget, and a driving agent that posts a lane's result is
reporting on work it did not do.

`DELETE /lanes/:id` is left out because teardown deliberately does not call it.
A torn-down lane keeps its row, and a terminal row is inert: `POST /lanes` only
conflicts against lanes that are not `completed` or `failed`. Deleting a live
lane instead orphans its worktree and its database, with nothing left in the
hub that knows they exist.

There are no MCP resources. Several clients ignore them, and everything a
resource would carry is already a tool that returns it.

## Troubleshooting

**Every tool says Laneward is unreachable.** The hub is not running. Start it
with `bun start` in the Laneward checkout, or check `HUB_URL` in the client
configuration if the hub listens somewhere other than
`http://127.0.0.1:8787`.

**`lane_create` refuses, naming `LANE_REPO`.** It is unset in the server's
environment. Set it in the client configuration and restart the client; the
server reads its environment at launch, so a change in your shell does not
reach an already-running server.

**`reset_stranded` refuses, naming `DATABASE_URL`.** It is the one tool that
does not go through the hub: `scripts/reset-stranded.ts` talks to Postgres
directly, because reclaiming a lane the hub thinks is running is exactly the
case where asking the hub is no help. Give the server the same `DATABASE_URL`
the hub uses.

**A lane was created but nothing is happening.** That is the normal shape.
`lane_create` only registers; the conductor dispatches. Check that the
conductor is running, and use `lane_gate` to see whether the lane is being held
back.
