# A clean repository, and a new name

Written 2026-08-19. This repository begins with one commit, and that is
deliberate. It replaces a private predecessor whose history is not carried over.

## Why the history is not here

The predecessor had 260 commits. It contained **no credential material**: no
tokens, no keys, no committed `.env`, and that was checked rather than assumed.
What it did contain, across both file contents and commit messages, was a
detailed picture of one developer's machine:

| | occurrences in that history |
|---|---|
| a WSL/Podman private address | 27 |
| Windows user paths | 14 |
| a Linux home directory | 2 |

None of it was secret. The address is RFC1918, unroutable, and changes whenever
the Podman machine is recreated. But the exposure was never really the strings:
it was that the commit messages and `docs/notes/` describe, at length, how one
laptop is configured. Scrubbing strings does not fix prose, and rewriting 260
commit messages is worse work than starting once, cleanly.

So the tree came across and the history did not. `docs/notes/` is kept in full,
because the record of what was tried and what it cost is the most useful thing
this project has; it simply no longer names the machine.

## The name

`lane-hub` became **Laneward**. The rename is total rather than cosmetic:
the product name, the package name, the systemd units, the Quadlet container,
the database role and database name, the `LANEWARD_*` environment prefix, and
the `.laneward/` manifest directory a driven repository declares.

It is total because this is `v0.1.0` with no installed users. A half rename
would have left the old name in every operator's configuration forever, and
there is exactly one moment when that costs nothing.

The vocabulary the code is built on (*lane*, `lane_id`, `owned_paths`,
`new-lane`) is untouched, which is most of why this name was chosen over the
alternatives: it keeps the word the whole design already turns on.

## Links that did not survive

The predecessor's GitHub issues and Actions runs are referenced throughout
`docs/`. Those threads did not move, and pointing a link at this repository
would fabricate a destination that never existed here. Every such link is now
plain text: `issue #12`, `CI run 31891261576`, so the reference survives and
the dead link does not.

Older notes also cite commit SHAs: `measured at 3088e79` and the like. Those
belong to the predecessor and do not resolve here either. They are left in place
because they say *when* something was measured relative to the work around it,
which is the part that still reads; rewriting 38 of them would damage the notes
to fix a link nobody could follow either way.

## What was thrown away with the history

`docs/` came across at 50 files and 67,000 words and left at 28 and 35,000. What
went was spent input rather than record: fourteen lane briefs for work that has
shipped (two of them for a different project entirely), three phase designs from
2026-08-01 that `docs/architecture/workflow-v1/` supersedes, one note whose own
header declared it superseded, and an archived gaps list that its successor
already absorbed.

Three overlapping planning documents (a remaining-work list, a shipping plan
and a stage plan, 7,500 words between them describing mostly finished work)
became one: [what is left](2026-08-19-what-is-left.md). Anyone who wanted the
open items previously had to reconcile all three.

The evidence notes were not touched. The record of what was run, what it found
and what it did not establish is the most useful thing this project has.

## What was verified before the first commit

`bun install --frozen-lockfile`, `bun run typecheck`, `bun run db/migrate.ts`
against a fresh database, and the full suite: **299 pass, 2 skip, 0 fail**. A
case-insensitive sweep of the whole tree finds no occurrence of the old name.

The development database was migrated too. Its nine lanes were all `completed`
and pointed at worktrees under the predecessor's path, so nothing was in flight
and nothing was carried over: a fresh `laneward` container and volume replaced
the old one, and a full dump of the old databases was kept outside the
repository first.
