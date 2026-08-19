# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, if it exists;
- **`docs/architecture/workflow-v1/01-decisions.md`** — this repo's decision
  log, one `### D-0NN — <title>` entry per decision. Read the entries that touch
  the area you are about to work in.
- **`docs/architecture/workflow-v1/`** — the rest of the workflow-v1 documents
  describe the intended architecture; `09-implementation-roadmap.md` says which
  phase each part belongs to.

If `CONTEXT.md` doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates it lazily when terms actually get resolved.

## Where decisions go

This repo is single-context and keeps **one** decision log. There is no
`docs/adr/` directory and one should not be created: a second decision source
would make it ambiguous which one is current. Append a new decision to
`docs/architecture/workflow-v1/01-decisions.md` in that file's existing style.

**Numbering is not sequential in file order** — D-022 and D-023 sit above D-019,
and there are lettered entries like D-009a. Take the next free number by reading
every `### D-0` heading, not by looking at the last one. Numbers are cited from
other documents in about two dozen places, so an existing number is never
reused or renumbered.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts a recorded decision, surface it explicitly rather than silently overriding:

> _Contradicts D-008 (Codex never performs Git mutations) — but worth reopening because…_
