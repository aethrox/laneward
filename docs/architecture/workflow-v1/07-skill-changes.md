# Required Skill Changes

The current skills contain useful behavior, but several rules conflict with the approved architecture.

No skill should be edited until its exact diff is planned and approved.

## `agent-routing`

Required changes:

- preserve Claude as the main reasoning loop;
- preserve read-only Claude subagents for research and review;
- route every write task through Laneward;
- remove the blanket requirement that every subagent creates its own write worktree;
- make Laneward the sole owner of write worktrees;
- require plan approval before write dispatch;
- verify all delegated output.

## `codex-fleet`

Required changes:

- remove every exception that permits Codex to commit;
- remove independent worktree creation for normal write execution;
- turn fleet execution into a Laneward worker adapter;
- retain bounded prompts, owned paths, model selection, and local validation;
- keep direct use only as an explicitly approved emergency or diagnostic path;
- default Codex network access to denied.

Codex Fleet must no longer act as a competing orchestrator.

## `research-first`

Required changes:

- retain the no-edit research phase;
- retain explicit approval before implementation;
- replace Obsidian outputs with project-local plan and decision records;
- record research assumptions and unresolved questions in the plan revision.

## `session-handoff`

Required changes:

- remove Obsidian as the state destination;
- load and update project-local handoff data;
- include active Laneward plan, pending approvals, ready-for-review lanes, and runtime state;
- treat Laneward as live operational truth;
- avoid copying transient status into committed decision files.

## `explain-plainly`

Keep and extend:

- use it for plan explanations;
- use it for approval requests;
- use it for verification-layer findings;
- separate user impact from technical details;
- never hide risk behind simplified wording.

## `ship-repo`

Required changes:

- preserve explicit approval for merge and push;
- integrate with Laneward plan and integration-branch state;
- reject publication when integration gates are incomplete;
- record the user approval before remote mutation.

## `ship-service`

Required changes:

- preserve separate approval for runtime effects;
- use `.laneward/project.json` for installation and verification contracts;
- require rollback for consequential service changes;
- record real service evidence before declaring completion.

## `gptpro-handoff`

Status: disabled.

Reason: there is no active GPT Pro subscription. The skill may remain archived or installed, but routing must never select it automatically and no workflow may depend on it.

## OMP-related skills

Status: excluded.

OMP has been removed from the architecture and roadmap. No fallback, adapter, or placeholder should be added.

## Prompt style

The existing prompt-style guidance may remain a reference for difficult prompts. It is not an execution component and must not become a mandatory layer for routine work.

## New `laneward-orchestrator` skill

A focused skill should eventually define how Claude:

- reads project and Laneward state;
- performs research;
- constructs a plan;
- requests approval;
- creates lanes;
- waits for or inspects results;
- reviews and commits;
- integrates;
- requests runtime approval;
- verifies real operation;
- closes the plan.

This skill describes the standard workflow. Hooks and Laneward enforce the hard boundaries.
