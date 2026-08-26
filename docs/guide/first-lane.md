# Your first lane

This page drives one real task through Laneward end to end: a brief, a lane, an
agent, a verdict, and the work in your hands. It assumes a hub is running and an
agent is declared ([Install](install.md), [Configuration](configure.md)).

## 1. Write a brief

The brief is the entire contract. The agent cannot see the conversation that
produced it. Copy [the template](../brief-template.md) and fill it in;
[Writing briefs](writing-briefs.md) explains what makes one score correctly.

For now, the shortest brief that works:

```markdown
## Task: make the login form reject an empty password

Working directory: `/home/you/your-repo-worktrees/fix-login`

## Context
`src/auth/login.ts` submits with an empty password field and the server
returns 500.

## Scope
You own exactly these files:
- `src/auth/login.ts`
- `tests/auth/login.test.ts`

Do NOT touch anything else, and never anything under `.git`.

## Definition of done
- `bun test tests/auth` is green.
- No file outside the owned list is modified.

## Escalation: read this before you stop
If the brief is wrong or ambiguous, change nothing and print, on a line of its
own: `APPROVAL REQUIRED: [your question]`
```

Save it as `brief.md`.

## 2. Register the lane

```bash
LANE_REPO=/home/you/your-repo \
  bun scripts/new-lane.ts fix-login brief.md 'src/auth/*' 'tests/auth/*'
```

!!! danger "An owned path is a glob over file paths, not a directory"

    `src/auth` matches the file `src/auth` and nothing else. It does **not**
    cover `src/auth/login.ts`, and a lane that edits that file is failed for an
    ownership violation even though its work is correct. `*` does not cross a
    `/`, so a nested file needs its own pattern: `'src/auth/*'` covers one
    level, `'src/auth/*/*'` the next. [Writing briefs](writing-briefs.md#owned-paths)
    has the measured demonstration.

The script takes no flags. Everything optional is an environment variable:

| Variable | Default | Effect |
|---|---|---|
| `LANE_REPO` | Laneward's own checkout | The repository this lane works on. |
| `LANE_WORKTREE_ROOT` | `<repo>-worktrees` beside the repo | Where the worktree is created. |
| `LANE_TYPE` | `write` | `write` or `read_review`. |
| `LANE_MODEL` | `balanced` | `fast`, `balanced` or `deep`. |
| `LANE_DEPENDS_ON` | none | Whitespace-separated lane ids that must be `completed` first. |
| `LANE_PLAN_REVISION_ID` | none | Binds the lane to a plan revision. See [Plans and authority](plans-and-authority.md). |
| `HUB_URL` | `http://127.0.0.1:8787` | Where to register. |

The lane id is a slug: letters, digits, dot, underscore and dash, starting with
a letter or digit, at most 64 characters. It names a directory and a branch, so
anything else is refused with the rule spelled out.

### What it creates, in order

1. `git worktree add -b lane/fix-login <root>/fix-login`
2. a copy of the driven repository's `.env` into the worktree, with
   `DATABASE_URL` rewritten to a database created for this lane
   (`<yourdb>_lane_fix_login`)
3. `bun install` in the worktree
4. `bun run db:migrate` in the worktree, if the driven repository declares that
   script
5. registration with the hub

On success it prints the three things you need:

```
Worktree: /home/you/your-repo-worktrees/fix-login
Lane: fix-login
Database: your_repo_lane_fix_login
```

Anything that fails after the worktree exists is rolled back: the lane database
is dropped, the worktree is removed, the branch is deleted. You are not left
with debris to clean up by hand.

!!! note "`bun install` output is added to your owned paths for you"

    A first-time lockfile written by `bun install` would otherwise be scored as
    a file the agent touched without owning. The script diffs the worktree
    before and after installing and appends whatever appeared to `owned_paths`.

### Two refusals you may hit

**A missing `.env` in the driven repository**, when it ships a `.env.example`:

```
Repository .env is missing: /home/you/your-repo/.env
Write one with development values before opening a lane. Copying .env.example
is not safe by default: it carries the installed deployment's database target,
and a lane pointed at that can destroy real data.
```

**An overlapping lane.** The hub answers `409` with the culprit named:

```json
{"error":"owned_paths conflict","conflicting_lane_id":"refactor-auth"}
```

Two lanes that claim the same path cannot both exist unfinished. Finish, fail or
delete the other one, or narrow the paths.

## 3. Let the conductor run it

```bash
bun run conductor          # one pass
bun run conductor --loop   # keep going
```

A single pass prints a summary and exits non-zero if anything failed:

```
--- summary ---
completed:        fix-login
waiting approval: -
failed:           -
logs: /home/you/.local/state/laneward/logs
```

While it runs, watch [the dashboard](http://127.0.0.1:8787). The lane card shows
its status, its attempt count, its owned paths, and a live tail of the agent's
log. `whole log` links to the full file.

## 4. Read the verdict

| Outcome | What happened |
|---|---|
| `completed` | The agent exited 0, every dirty path was inside `owned_paths`, and the driven repository's declared checks passed. |
| `waiting_approval` | The agent exited 10, or printed an escalation marker. Answer it, and the lane runs again with your decision appended to the brief. |
| `failed` | Three attempts used up, a failed check, a path outside `owned_paths`, or a git mutation. |

`completed` does not mean correct. It means the agent stayed inside its box and
the checks you declared went green.

If a lane is `waiting_approval`, resolve it and the conductor picks it up again:

```bash
curl -s http://127.0.0.1:8787/pending          # find the approval_id
curl -s -X POST http://127.0.0.1:8787/approvals/<approval_id> \
  -H 'content-type: application/json' \
  -d '{"resolved_by":"human","decision":"Yes, rejecting an empty password is in scope."}'
```

## 5. Take the work

Laneward never commits. The agent's work sits uncommitted in the worktree, on
the branch `lane/fix-login`:

```bash
cd /home/you/your-repo-worktrees/fix-login
git diff                       # this is what the agent did
git add -A && git commit -m "reject an empty password"
```

Then merge it in your own repository the way you normally would, and only then
tear the lane down:

```bash
bun run teardown fix-login
```

Teardown drops the lane database, removes the worktree and deletes the branch.
It refuses, and removes nothing, while the worktree is dirty or the branch
carries commits your repository does not have:

```
Refusing to tear down fix-login. Nothing was removed.

Commits on lane/fix-login that /home/you/your-repo does not carry:
  a1b2c3d reject an empty password
```

That refusal is the safety net for exactly this step: nothing you have not
integrated is ever deleted for you.
