# AGENTS.md

Laneward is written in English: identifiers, comments, tests, documentation and
commit messages. Conversation with the user is Turkish; artifacts are not.

## Agent skills

### Issue tracker

Decision tickets and specs live as GitHub issues in `aethrox/laneward`, driven
through the `gh` CLI. Laneward's own plan, revision and lane records are a
different thing: they track approved work in flight, not open questions. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. Nothing
uses them yet: this repo has no external reporters. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context. Decisions do **not** live in `docs/adr/`; this repo keeps one
decision log at `docs/architecture/workflow-v1/01-decisions.md`. See
`docs/agents/domain.md`.

## Working rules

Learned the expensive way, and true of every change rather than of one stage.

- **Verify on this host.** Codex's sandbox cannot spawn processes in tests, so
  its own acceptance run proves nothing about a spawn-based suite. Re-run
  `bun test` and `bun run typecheck` here before believing a lane.
- **The suite truncates whatever `DATABASE_URL` points at.** Run it against
  `laneward_test`, never against `laneward`.
- **Start the hub and the conductor detached**, never as harness background
  tasks: those get killed mid-run and leave an orphaned worker writing into a
  worktree nothing is scoring.
- **A lane's artifacts are English**, including its escalation messages. Say so
  in the brief; one lane answered its escalation in Turkish.
