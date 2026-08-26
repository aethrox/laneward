# Troubleshooting

Symptom first. Most of these are the system refusing on purpose, and the refusal
text names the cause.

## A lane will not start {#lane-will-not-start}

It stays `pending` and nothing happens. Ask why:

```bash
curl -s http://127.0.0.1:8787/lanes/fix-login/gate
```

The answer is one of these, checked in this order:

| Reason | What it means | What to do |
|---|---|---|
| `lane not found` | No such lane id. | Check `GET /lanes`. |
| `lane's plan revision is not approved` | Bound to a revision nobody approved. | `POST /plans/:id/revisions/:n/approve`. |
| `lane's plan revision 1 is superseded by revision 2` | A newer revision exists. | Re-register the lane against the newest revision. |
| `lane has a pending approval request` | It is waiting on you. | Resolve it: `POST /approvals/:id`. |
| `dependency not found: build-schema` | A `depends_on` entry names a lane that does not exist, usually a typo. | Fix the id, or register the missing lane. |
| `dependency not completed: build-schema` | The lane it waits on has not finished. | Wait, or unblock that lane. |
| `active lane limit reached (3)` | `MAX_ACTIVE_LANES` is full. | Wait, or raise it. |
| `owned_paths conflict with a running lane` | Another running lane claims overlapping ground. | Wait for it, or narrow the paths. |

A gate that refuses is not an error. The lane stays `pending` and is tried again
on the next drain pass.

## The lane failed with an ownership violation

```
FAIL: ownership violation: src/auth/deep/util.ts
```

`owned_paths` is a glob over file paths, and `*` does not cross a `/`, so
`src/auth` does not cover `src/auth/login.ts`. This is the most common way a
correct lane fails; the measured table is in
[Writing briefs](writing-briefs.md#owned-paths).

Re-register with a pattern per directory level, and put the same list in the
brief so the agent knows where the fence is.

## The lane failed and was not retried

```
FAIL: Git boundary violation: HEAD changed, index has staged entries
```

A Git-boundary violation is not retryable: it fails on the spot. Laneward owns
git, so the agent must not commit, stage, checkout, or reach for anything that
is not identifiably a read.

Look at `<log dir>/<lane_id>.git-guard.jsonl` for what was refused. A refused
**read** is reported and does not fail the lane; a refused **mutation** does.
The `claude` preset denies `Bash(git *)` at the agent for exactly this reason;
if you drive a raw agent, say the same thing in the brief.

## The lane parked itself in waiting_approval

Four things do that, and the question text says which:

| Question | Meaning |
|---|---|
| `lane <id> reported: "APPROVAL REQUIRED: ..."` | The agent asked. Answer it. |
| `lane <id> reported: "HOST VERIFICATION REQUIRED: ..."` | Work is done but a claim is unverified. Verify it yourself, then answer. |
| `lane <id> failed its lane checks: test` | The declared checks went red. Read `<lane_id>.check-*.log`. |
| `lane <id> exited 0 without producing changes and needs a decision` | A write lane that changed nothing. Usually a brief the agent decided was already satisfied. |

Resolve with `POST /approvals/:id`, and write the `decision` as an instruction:
it is appended to the brief when the lane runs again.

## The agent hangs and never exits

Almost always an agent that takes its prompt as a positional argument. Laneward
writes the brief to **stdin**, so such an agent sits waiting on a stdin that is
already closed to it, forever. There is no timeout on the agent process.

Fix the command template so the agent reads stdin. Kill the conductor, then
`bun run reset-stranded` to return the lane to `pending`.

## The first lane fails with no agent declared

```
no agent declared: set LANEWARD_AGENT to one of (codex, claude), or set
LANEWARD_AGENT_WRITE to a JSON argument array
```

There is no default agent, by design. See
[Configuration](configure.md#declaring-an-agent). A wrong preset name is refused
just as clearly: `LANEWARD_AGENT must be one of: codex, claude (got "gemini")`.

## The reader never runs

Its status is `skipped` and the reason says so. Either the driven repository
declares no `reader.test_paths`, or you set `LANEWARD_AGENT_WRITE` without
`LANEWARD_AGENT_READ`, in which case there is no read-only command and Laneward
will not run the reader unconfined over the code it is reviewing.

## The hub will not start

```
invalid LANEWARD_NOTIFY class: aproval_required
```

A typo in a notification class is fatal rather than ignored, so a misspelled
class cannot silently disable an alert you think is on. The four names are
`approval_required`, `lane_failed`, `plan_ready_for_review`,
`findings_to_adjudicate`.

```
DATABASE_URL is not set: copy .env.example to .env
```

Exactly what it says. Note that `.env.example` ships port **5433**, the one the
shipped container publishes; a PostgreSQL you already run is probably on 5432.

## The test suite refuses to run

```
refusing to run tests against laneward: the suite truncates lanes, messages and
approvals. Point DATABASE_URL at laneward_test, a name ending in _test, or a
laneward_lane_* database.
```

The suite truncates whatever it connects to. Point it at `laneward_test`, never
at the database your lanes live in.

## Lanes are running but nothing is happening

Their conductor is gone: a crash, a reboot, or a stopped Windows scheduled task.

```bash
bun run reset-stranded --dry-run
bun run reset-stranded
```

Stop any live conductor first: `reset-stranded` cannot tell a stranded lane from
a healthy one and resets every `running` lane it finds.

## The agent is looking at the wrong database

You started the conductor as `bun run conductor.ts` instead of
`bun run conductor`. The package script passes `--no-env-file`; without it Bun
auto-loads the `.env` in the current directory and pushes Laneward's own `PORT`
and `DATABASE_URL` into every agent it spawns, so the agent talks to the hub's
database rather than its lane's.

## Registration is refused

```json
{"error":"owned_paths conflict","conflicting_lane_id":"refactor-auth"}
```

Two lanes cannot claim overlapping ground while both are unfinished. Complete,
fail or delete the other one, or narrow the paths. Note that the overlap check
compares paths as prefixes, so `src` collides with `src/auth` even though the
evidence check would not treat one as covering the other.

```
Repository .env is missing: /home/you/your-repo/.env
```

The driven repository ships a `.env.example` and has no `.env`. Write one with
development values. Copying the example is not safe by default: it carries the
installed deployment's database target, and a lane pointed at that can destroy
real data.

## Teardown refuses

```
Refusing to tear down fix-login. Nothing was removed.

Uncommitted changes in /home/you/your-repo-worktrees/fix-login:
  src/auth/login.ts
```

That is the safety net working. Commit the work and merge it into your
repository first; teardown only removes a lane whose worktree is clean and whose
branch carries nothing your repository does not already have.

## Something broke only on Windows, with a stray carriage return

The POSIX git shim, `install.sh`, the systemd units and `.env.example` are
pinned to LF in `.gitattributes` because this repository is developed on Windows
with `core.autocrlf=true`. A CRLF in the shim makes its shebang unresolvable; in
`install.sh` it fails as `env: 'bash\r': No such file or directory`; in a systemd
unit it does not fail loudly at all, it puts a carriage return inside every
value. If you copy any of these files elsewhere, keep the line endings.

## The dashboard says "disconnected, retrying"

The page holds one server-sent event stream and reconnects on its own. That
message means the hub is not answering: check that `bun run start` is still up
and that you are on the right port.
