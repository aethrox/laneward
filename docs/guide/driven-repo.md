# Preparing the driven repository

Laneward can drive a repository that knows nothing about it: nothing below is
required to run a lane. What a manifest buys you is a verdict worth trusting.
Without one, `completed` means only "the agent exited 0 and stayed inside its
paths".

The manifest lives at `.laneward/project.json` in the driven repository, and is
read from the lane's worktree.

## The whole file

Laneward's own manifest is a worked example of every section:

```json
{
  "version": 1,
  "checks": {
    "lane": [
      { "name": "test", "command": ["bun", "test"] }
    ]
  },
  "reader": {
    "test_paths": ["tests"]
  },
  "clean_run": {
    "shell": { "win32": ["bash", "-lc"], "linux": ["bash", "-lc"] },
    "environment": { "PORT": "8799" },
    "seed": "bun run scripts/seed-clean-run.ts",
    "seed_timeout_ms": 30000,
    "start": "exec bun run start",
    "observation_window_ms": 8000,
    "expectations": [
      {
        "name": "approval_required notification is delivered",
        "must_appear": "desktop notification sent: approval_required"
      },
      {
        "name": "notification delivery does not fail",
        "must_not_appear": "desktop notification failed:"
      }
    ]
  }
}
```

`version` must be exactly `1`. Anything else, or unparseable JSON, makes the
whole manifest `unrunnable`, and a lane whose checks cannot run stops for a
human rather than being scored.

## `checks.lane`: what runs after every lane

Each entry needs a non-empty `name` and a `command` array of non-empty strings.
Names must be unique; a duplicate is a manifest error, not a silent overwrite.

```json
"checks": {
  "lane": [
    { "name": "typecheck", "command": ["bun", "run", "typecheck"] },
    { "name": "test", "command": ["bun", "test"] }
  ]
}
```

Each command runs with the worktree as its working directory, and with
`DATABASE_URL` removed from the inherited environment so it reads the lane's own
`.env` and its own database. Output goes to
`<log dir>/<lane_id>.check-<n>-<name>.log`, and the results are recorded as
evidence against the lane, visible on the dashboard and through
`GET /lanes/:id/evidence`.

The overall verdict is the worst one: any `unrunnable` check makes the run
unrunnable, otherwise any failure makes it failed, otherwise it passed. A lane
with no declared checks records `not_configured`, which is not a failure.

| Outcome | What the lane does |
|---|---|
| passed | Continues to `completed`. |
| failed | Parks in `waiting_approval`: `lane <id> failed its lane checks: test`. |
| unrunnable | Parks in `waiting_approval` with the reason, for example a timeout. |

A check is killed after `LANEWARD_CHECK_TIMEOUT_MS`, ten minutes by default, and
recorded as `unrunnable` with `timed out after 600000 ms`.

!!! tip "Declare the command your briefs already promise"

    The [definition of done](writing-briefs.md#definition-of-done)
    in a brief and the declared lane checks should be the same ground. If the
    brief promises `bun test tests/auth` is green and no check runs anything,
    nobody measured the promise.

## `reader.test_paths`: what the reader reviews

A non-empty array of paths. It is used as the pathspec that splits the
candidate's diff in two: the tests are the reader's subject, everything else is
context it may read but is not reviewing.

```json
"reader": { "test_paths": ["tests", "spec"] }
```

Missing or malformed, and the reader layer is recorded as `skipped` with the
reason rather than run on a guess. The reader is advisory and never blocks;
see [Plans and authority](plans-and-authority.md#the-reader).

## `clean_run`: installing the candidate the way a new machine would {#clean-run}

The clean-run layer builds nothing of its own. It starts the integration
candidate from scratch, watches its output for a fixed window, and scores what
appeared against expectations you declare.

| Key | Required | Meaning |
|---|---|---|
| `shell` | yes | Interpreter per platform, keyed by `process.platform` (`linux`, `win32`). Your platform must be present. |
| `environment` | no | Extra variables for the run. `DATABASE_URL` is rejected: the candidate gets its own. |
| `seed` | no | A command run before start, for fixtures. |
| `seed_timeout_ms` | no | Ceiling for the seed. Default `30000`. |
| `start` | yes | The command that starts the thing. |
| `observation_window_ms` | yes | How long its output is watched. |
| `expectations` | yes | Named patterns, each with exactly one of `must_appear` or `must_not_appear`. |

Each expectation needs a unique name and exactly one pattern, compiled as a
multiline regular expression. Both of these are wrong and are refused as
manifest errors rather than being half-applied: two patterns in one expectation,
or none.

`LANEWARD_CLEAN_RUN_SHELL` overrides the interpreter and must be an absolute
path. On Windows an interpreter under `System32` is refused, because
`bash` there is WSL and starts an entirely different operating system than the
one the candidate was built on.

## What this gets you

With all three sections declared, a plan revision whose lanes are all
`completed` is built into a candidate, installed clean, started, watched, and
read; each layer's result is recorded against the revision and shown on the
dashboard. Without them, the same revision reaches you as a set of green lanes
and no evidence that they work together.
