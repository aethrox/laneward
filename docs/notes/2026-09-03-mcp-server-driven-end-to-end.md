# The MCP server, driven for real

The MCP server, added 2026-08-27 at `2755b3d`, was the last seam here that
had never been exercised. Since it landed its coverage came from
`tests/mcp.test.ts`, which calls `handle()` in-process — no real subprocess
boundary, no stdin loop, no stdout discipline. This run drove it as a real
stdio child instead.

Run on 2026-09-03 against `7732bdf`, unmodified.

## The host

Windows 11 Pro 26200, Bun 1.3.14, git 2.54.0.windows.1, Claude Code CLI
2.1.233. Postgres 16-alpine inside a Podman machine (WSL), addressed at
`172.22.74.103:5433` — the machine's own address, not `127.0.0.1`, because the
port forward to the Windows host was dead, the same defect S3 hit on
2026-08-19. The driven repository was a throwaway git repo under the session
scratchpad with one file's worth of work: `src/greet.ts`'s `greet()` returned
an empty string. The agent was the `claude` preset at the `fast` tier.

## The result

A minimal stdio client (`mcp-drive.ts`) spawned `bun run --no-env-file mcp.ts`
as a real child process and exchanged JSON-RPC over its stdin/stdout, logging
every line:

```
>> initialize -> << protocolVersion "2025-06-18" (pinned), serverInfo
   {name: "laneward", version: "0.1.0"}
>> tools/list -> << 17 tools listed
   child exited with code 0
```

Every stdout line parsed as JSON-RPC; the client treats a non-JSON stdout
line as a protocol defect, and none occurred. Stderr carried only the
process's own diagnostics. The child exited 0 on every run in the session.

`lane_create` refuses before creating anything when `LANE_REPO` is unset —
`src/mcp.ts:307-309`: `"LANE_REPO is not set, so a lane would be opened on
Laneward's own checkout instead of the repository you meant... Nothing was
created."` With `LANE_REPO` pointed at the throwaway repo, the same call
actually registered the lane: `"Lane 'greet-fix' is registered and
pending... Worktree: ...\driven-repo-worktrees\greet-fix Database:
laneward_driven_lane_greet_fix"`.

Bound to an unapproved plan revision, its gate stayed shut —
`"Lane 'greet-fix' may not run: lane's plan revision is not approved.
{"allowed": false, "reason": "lane's plan revision is not approved"}"` —
and opened after `plan_approve`: `"Lane 'greet-fix' may run: ok."`

A lane left `running` by a killed conductor was reported correctly in
`dry_run` and then actually reset:

```
>> reset_stranded {dry_run: true}
<< "Dry run: nothing was changed. Would reset 1 stranded lane(s) to
   pending: greet-fix"
>> reset_stranded {dry_run: false}
<< "Lane state was rewritten. Reset 1 stranded lane(s) to pending:
   greet-fix"
```

`lane_teardown` reported the database, worktree and branch as gone
(`"Dropped database: laneward_driven_lane_greet_fix. Removed worktree:
...\greet-fix. Deleted branch: lane/greet-fix"`), and this was checked
independently rather than taken on the tool's word:
`driven-repo-worktrees` is empty, `git worktree list` in the driven repo shows
only the main checkout, and `git branch -a` lists only `master`. That is also
the regression check for `ec5b144` (2026-08-27, a teardown that reported
deletion without performing it).

The conductor picked the lane up, spawned the agent, and after failures moved
it to `failed`, recording the agent's own error line in the lane log — the
conductor side of the lifecycle, running separately from the MCP driver.

## Finding: the repo's own `.mcp.json` cannot open a lane

`.mcp.json` in this checkout is `{"mcpServers":{"laneward":{"command":"bun",
"args":["run","--no-env-file","mcp.ts"]}}}` — no `env` block. A Claude Code
session opened on the Laneward checkout itself therefore cannot run
`lane_create` or `reset_stranded`: both refuse with the exact messages above
(`LANE_REPO is not set...`, and equivalently `DATABASE_URL is not set in this
server's environment...`). `docs/guide/mcp-server.md` shows the `env` block
for Codex and Cursor configs but the repository's own `.mcp.json` omits it.
The refusal messages are clear enough that this isn't a trap, but the file as
shipped does not let the server drive itself.

Fixed 2026-09-04: the file now forwards both variables from the shell that
started the client, with empty defaults so an unset variable still produces the
refusals above rather than a literal `${VAR}`. Unverified by a run — a server
reads its environment once, at startup.

## Finding: the guide's manual conductor command drops the environment

`docs/guide/first-lane.md:126-127` tells the reader to run `bun run
conductor`. That script carries `--no-env-file` (`package.json`), which
`src/conductor.ts:137-142` does deliberately — so Laneward's own `PORT` and
`DATABASE_URL` don't leak into a lane's worker. The consequence for a reader
who follows the guide and put `LANEWARD_AGENT=claude` in `.env`:

```
$ bun run --no-env-file conductor.ts --loop
conductor loop started, draining every 5000 ms
greet-fix: started
greet-fix: error - no default model for tier "fast": no agent preset is
active, set LANEWARD_MODEL_FAST
```

This happened in this run, not hypothetically. `install.ps1:262` gets it
right for the service path: `bun --env-file="$EnvFile" run --no-env-file
conductor.ts --loop`. Repeating the manual command with `--env-file` let the
run continue (`greet-fix: started` three times, then `greet-fix: failed`).
So the installed service is fine; the guide's hand-run command is not.

Fixed 2026-09-04, in the script rather than the pages: `conductor` is now
`bun --env-file=.env run --no-env-file conductor.ts`. The same lane, re-run
after the change, no longer errors on the preset and reaches the agent.

Chasing it further found that the installed service was not fine after all —
`--no-env-file` was the only thing holding Laneward's `PORT` back from a
worker, and both service installs load `.env` regardless (`EnvironmentFile` on
Linux, `--env-file` on Windows), so `PORT` had been reaching every agent they
spawned. `buildWorkerEnv` strips it now alongside `DATABASE_URL`. A lane driven
by a probe agent that prints its own environment reports what a worker sees
after the fix:

```
PORT=undefined DATABASE_URL=postgres://.../laneward_driven_lane_port_check
```

The hub's port is gone, and the connection string is the lane's own database
from its worktree `.env` rather than the hub's — which is what the boundary was
always meant to produce.

## What this does not establish

The agent step itself was not reached. The spawned `claude` process exited
with `Failed to authenticate: OAuth session expired and could not be
refreshed`. This is not attributable to Laneward: the identical command, run
directly from the shell with no supervisor involved, produced the same line:

```
$ echo "Reply with exactly: OK" | claude -p --permission-mode plan \
    --disallowedTools Edit Write NotebookEdit Bash --model haiku
Failed to authenticate: OAuth session expired and could not be refreshed
```

The host's `claude` CLI session had simply expired. Consequently, none of the
following were established by this run:

- The agent actually modifying the file it owned.
- `check-evidence` running against a real agent's output.
- An `owned_paths` violation being caught in a real violation.
- A lane reaching a `completed` verdict.
- The `build_candidate` and `lane_answer` tools — neither was called.
- The git shim intercepting a real agent's Git calls.

What is established is the MCP server's protocol layer, every lane
lifecycle step that belongs to Laneward itself, and everything up to and
including spawning the agent. What is not established is anything from the
agent's own execution onward.

## Cleaned up

The lane was removed by `lane_teardown` (database, worktree, branch), and the
removal was independently confirmed rather than trusted. The conductor and
hub processes were stopped. The Postgres container and the Podman machine
were returned to their pre-run state — both stopped. `LANEWARD_AGENT=claude`
added to Laneward's own `.env` during this run was left in place: it is a
fix, not a side effect of the run, and the file is already gitignored. The
throwaway driven repository remains in the session scratchpad.
