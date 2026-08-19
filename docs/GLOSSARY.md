# Glossary

Terms this project uses in a specific sense. Where a term has a general meaning
in software and a narrower one here, the narrower one is what is written down.

## The parts of the system

**Hub** — the long-running web service (`index.ts`, `src/app.ts`) that holds all
the records: plans, lanes, messages, approvals, notifications. It decides
nothing on its own; it answers questions and stores answers. Runs on
`127.0.0.1:8787`.

**Conductor** — the process that does the work the hub only records
(`conductor.ts`, `src/conductor.ts`). It asks the hub which lanes may start,
starts them, and reports what happened. It exists so work continues while no
Claude Code session is open.

**Plan** — one approved piece of work, large enough to be split into several
lanes. Has an id, a title, and one or more revisions.

**Plan revision** — a numbered version of a plan's content. Changing material
scope creates a new revision rather than editing the old one, so what was
approved stays readable. Only the newest revision's lanes may run.

**Lane** — one bounded task inside a plan, given to one worker. It owns a set of
file paths nobody else may touch, a git branch (`lane/<lane_id>`), a worktree,
and usually a database of its own.

**Worker** — the agent that executes a lane. Here that is Codex, run through
`codex exec` in a sandbox.

**Brief** — the written instruction a lane's worker receives. It is the entire
contract: the worker cannot see the conversation that produced it.

## Git and filesystem terms as used here

**Worktree** — a second working directory attached to the same repository, on a
different branch. Two lanes can edit the same project at the same time without
sharing files. Created and removed with `git worktree`.

**Slug** — an identifier safe to use as a directory name and a branch name:
letters, digits, dot, underscore, dash, starting with a letter or digit, at most
64 characters. Enforced in `src/slug.ts`, because a `/` or a `..` in an id
reaches outside the directory it was supposed to stay in.

**Teardown** — the explicit command that removes what a lane created: its
worktree, its branch, its database (`bun run teardown <lane-id>`). Nothing runs
it automatically, so nothing is deleted at a moment nobody is watching.

## Integration and verification

**Integration candidate** — the merged, installed, runnable tree built from all
the lanes of a plan revision, on branch `integration/<plan_id>-r<revision>`. It
is the thing that gets checked before anything reaches the real branch. Built by
`bun run build-candidate <plan_id>`.

**Base commit** — the commit the candidate branch was forked from. The change
being reviewed is the difference between the base commit and the candidate.

**Clean run** — installing the candidate from scratch on a fresh database and
running it, the way a new machine would. Catches what a passing test suite
cannot: things that only break on first install or first start.

**Reader** — the review layer that reads the change rather than running it. A
Codex lane whose declared subject is the test diff: did this change weaken what
the tests prove? It advises and never blocks, because it does not answer the
same question the same way twice.

**Shadow mode** — a check that runs and records but stops nothing. How a new
check earns trust before it is given the power to block.

**Finding** — one thing a check reported, kept as its own record with a
lifecycle: `open`, `accepted`, `rejected`, `deferred`. `rejected` exists so a
false alarm that was already investigated does not come back forever.

**Evidence** — the recorded output of the checks that ran, stored against the
lane so a returning session finds results rather than unstarted work.

**Gate** — the hub's answer to "may this lane start right now?". Checks plan
approval, dependencies, path conflicts, and the active lane limit.

## Process terms

**D-0NN** — a numbered decision in
`docs/architecture/workflow-v1/01-decisions.md`. The numbering is not sequential
in file order, so the next free number has to be found by reading every heading.

**Grilling** — a round of interview questions used to settle an open decision
before any code is written, each question carrying a recommended answer and the
evidence behind it.

**Escaped defect** — a real fault that reached the operator despite everything
that ran. The ledger of these is what the verification layer is measured
against.
