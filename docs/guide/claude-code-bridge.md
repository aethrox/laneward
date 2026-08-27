# The Claude Code bridge

`scripts/bridge.ts` connects an interactive Claude Code session to a running
hub. It is optional: lanes run without it. With it, the session knows what is
blocked before you ask, and, if you want it, refuses to edit inside a lane
worktree the hub has not cleared.

`HUB_URL` is the only variable it reads (default `http://127.0.0.1:8787`), and
every request it makes times out after two seconds.

## What is wired in this repository

One hook, in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run ${CLAUDE_PROJECT_DIR}/scripts/bridge.ts state",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

At the start of every session, `bridge state` reads `/pending` and `/lanes` and
hands the session one line of context:

```
Laneward: 1 lane(s) blocked on an unapproved plan revision; 2 lane(s) waiting on
a human; 0 failed lane(s).
```

If the hub is down it still returns valid output, and says so rather than
failing the session start:

```
Laneward is unreachable; gate status is unavailable.
```

## The gate, and why it is not wired

`bridge gate` implements the `PreToolUse` contract in full: it reads the hook
payload on stdin and decides whether the tool call may proceed.

1. If the working directory is **not** inside a linked worktree, allow. This is
   a filesystem check and happens before any HTTP, so a hub outage can never
   block work in your own checkout.
2. For `Bash`, allow anything on a read-only allowlist (`git status`, `git log`,
   `git diff`, `ls`, `cat`, `grep`, `rg`, `find` and similar), provided the
   command contains no shell metacharacters at all.
3. Otherwise ask the hub which lane owns this directory, and ask
   `GET /lanes/:id/gate` whether that lane may act.
4. Anything else, including a malformed payload, an unreachable hub or a
   timeout, is a denial.

A denial exits 2 and emits the deny decision with the gate's own reason, which
is what the session shows you.

!!! warning "It is deliberately left unwired, and that is worth understanding"

    Step 4 is fail-closed. Putting a fail-closed HTTP call in front of `Edit`,
    `Write` and `Bash` means a hub outage locks your own checkout, including the
    tools you would need to unwire the hook. The trade was measured and refused;
    see [Target architecture](../architecture/workflow-v1/02-target-architecture.md).

    If you wire it anyway, know that the escape hatch is editing
    `.claude/settings.json` from outside the session.

## The two convenience subcommands

Submitting a plan without hand-writing the HTTP call:

```bash
bun scripts/bridge.ts plan submit --title "Login hardening" --content plan.json
bun scripts/bridge.ts plan submit --title "Login hardening" --content plan.json --id login-hardening
```

It prints the plan id and the revision id. Pass `--id`: a generated UUID is
unaddressable later, and you need the plan id to add revisions to it.

Registering a lane, which simply forwards to `scripts/new-lane.ts` with your
environment and its exit code:

```bash
bun scripts/bridge.ts lane create fix-login brief.md 'src/auth/*'
```

Anything else prints the usage line:

```
Usage: bridge <state|gate|plan submit|lane create>
```
