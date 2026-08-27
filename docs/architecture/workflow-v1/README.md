# Claude Code + Laneward Workflow v1

Status: approved architecture baseline  
Decision date: 2026-08-03  
Revised: 2026-08-05 (roadmap order, check ownership, cleanup, documented-versus-enforced boundaries)  
Revised: 2026-08-07 (platform support, Git-boundary enforcement moved off the sandbox, Phase 2 probe measured)  
Implementation status (2026-08-15): largely implemented. The plan, lane, gate,
verification and dashboard surfaces described here exist and are covered by the
suite. What remains unbuilt is recorded per decision as a `Current state` line
and in the README's `Limitations`.

A `Current state` line in this document set states the date it was measured. A
line without a date is a memory, not a measurement.

This document set supersedes an earlier gaps-and-recommendations note, which was retired once it had been fully absorbed here.

## Purpose

This document set defines how Claude Code, Laneward, agent workers, project-local records, validation gates, Linux services, and the independent verification layer work together.

The system is intended primarily for:

- developing new applications;
- adding features and fixing defects in existing projects;
- building and maintaining Linux services;
- creating and operating automations.

A task is not complete merely because code was written or tests passed. It is complete only after the result is installed in its target environment and its real behavior is verified.

## Core distinction

Claude Code is the cognitive orchestrator. It interprets the user's goal, performs research, asks questions, produces a plan, makes judgment calls, and integrates results.

Laneward is the deterministic control plane. It records approved plans, creates and schedules lanes, enforces dependencies and ownership, tracks execution, stores evidence, manages approvals, and exposes operational state.

Laneward must not become a second reasoning brain. Claude decides; Laneward records and enforces the approved decision.

<div class="lw-diagram lw-diagram--wide" markdown="0">
<svg viewBox="0 0 1470 444" role="img" aria-labelledby="wf-e2e-t wf-e2e-d">
  <title id="wf-e2e-t">End-to-end workflow, by actor</title>
  <desc id="wf-e2e-d">Five lanes, one per actor. The user states a task and approves a plan; Claude
  researches, plans, reviews and commits; Laneward records the plan, dispatches lanes and holds the
  integration branch; Codex writes; CI gates the release candidate and verifies the deployment. An
  unapproved plan returns to Claude to revise, and a failed review returns the work to Laneward.</desc>
  <defs>
    <marker id="lw-arrow-wf-e2e" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path class="lw-arrowhead" d="M0,0 L7,3 L0,6 Z"/>
    </marker>
  </defs>

  <rect class="lw-band" x="0" y="44" width="1470" height="76"/>
  <rect class="lw-band lw-band--alt" x="0" y="120" width="1470" height="76"/>
  <rect class="lw-band" x="0" y="196" width="1470" height="76"/>
  <rect class="lw-band lw-band--alt" x="0" y="272" width="1470" height="76"/>
  <rect class="lw-band" x="0" y="348" width="1470" height="76"/>
  <text class="lw-band-label" x="14" y="86">User</text>
  <text class="lw-band-label" x="14" y="162">Claude</text>
  <text class="lw-band-label" x="14" y="238">Laneward</text>
  <text class="lw-band-label" x="14" y="314">Codex</text>
  <text class="lw-band-label" x="14" y="390">CI</text>

  <g class="lw-node">
    <rect class="lw-node-box" x="128" y="55" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="174" y="75" text-anchor="middle">User</text>
    <text class="lw-node-label" x="174" y="89" text-anchor="middle">task</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="242" y="131" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="288" y="147" text-anchor="middle">Claude</text>
    <text class="lw-node-label" x="288" y="161" text-anchor="middle">research</text>
    <text class="lw-node-label" x="288" y="175" text-anchor="middle">and plan</text>
  </g>
  <g class="lw-node lw-node--guard">
    <rect class="lw-node-box" x="356" y="55" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="402" y="75" text-anchor="middle">User</text>
    <text class="lw-node-label" x="402" y="89" text-anchor="middle">approval</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="470" y="207" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="516" y="223" text-anchor="middle">Laneward</text>
    <text class="lw-node-label" x="516" y="237" text-anchor="middle">plan and</text>
    <text class="lw-node-label" x="516" y="251" text-anchor="middle">lanes</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="584" y="283" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="630" y="299" text-anchor="middle">Codex</text>
    <text class="lw-node-label" x="630" y="313" text-anchor="middle">write</text>
    <text class="lw-node-label" x="630" y="327" text-anchor="middle">workers</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="698" y="131" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="744" y="147" text-anchor="middle">Claude</text>
    <text class="lw-node-label" x="744" y="161" text-anchor="middle">review</text>
    <text class="lw-node-label" x="744" y="175" text-anchor="middle">and tests</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="882" y="131" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="928" y="151" text-anchor="middle">Claude</text>
    <text class="lw-node-label" x="928" y="165" text-anchor="middle">commit</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="996" y="207" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="1042" y="227" text-anchor="middle">Integration</text>
    <text class="lw-node-label" x="1042" y="241" text-anchor="middle">branch</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="1110" y="359" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="1156" y="375" text-anchor="middle">Release</text>
    <text class="lw-node-label" x="1156" y="389" text-anchor="middle">candidate</text>
    <text class="lw-node-label" x="1156" y="403" text-anchor="middle">gate</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="1224" y="359" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="1270" y="375" text-anchor="middle">Deploy and</text>
    <text class="lw-node-label" x="1270" y="389" text-anchor="middle">runtime</text>
    <text class="lw-node-label" x="1270" y="403" text-anchor="middle">verification</text>
  </g>
  <g class="lw-node lw-node--ok">
    <rect class="lw-node-box" x="1338" y="359" width="92" height="54" rx="8"/>
    <text class="lw-node-label" x="1384" y="390" text-anchor="middle">Done</text>
  </g>

  <path class="lw-edge" d="M 220 82 H 270 V 131" marker-end="url(#lw-arrow-wf-e2e)"/>
  <path class="lw-edge" d="M 334 158 H 402 V 109" marker-end="url(#lw-arrow-wf-e2e)"/>
  <path class="lw-edge" d="M 402 55 V 26 H 306 V 131" marker-end="url(#lw-arrow-wf-e2e)"/>
  <text class="lw-edge-label" x="345" y="18" text-anchor="middle">Revise</text>
  <path class="lw-edge" d="M 448 82 H 516 V 207" marker-end="url(#lw-arrow-wf-e2e)"/>
  <text class="lw-edge-label" x="524" y="132">Approved</text>
  <path class="lw-edge" d="M 562 234 H 630 V 283" marker-end="url(#lw-arrow-wf-e2e)"/>
  <path class="lw-edge" d="M 676 310 H 744 V 185" marker-end="url(#lw-arrow-wf-e2e)"/>
  <path class="lw-edge" d="M 790 158 H 882" marker-end="url(#lw-arrow-wf-e2e)"/>
  <text class="lw-edge-label" x="836" y="148" text-anchor="middle">Pass</text>
  <path class="lw-edge" d="M 698 158 H 537 V 207" marker-end="url(#lw-arrow-wf-e2e)"/>
  <text class="lw-edge-label" x="617" y="150" text-anchor="middle">Fail</text>
  <path class="lw-edge" d="M 974 158 H 1042 V 207" marker-end="url(#lw-arrow-wf-e2e)"/>
  <path class="lw-edge" d="M 1088 234 H 1156 V 359" marker-end="url(#lw-arrow-wf-e2e)"/>
  <path class="lw-edge" d="M 1202 386 H 1224" marker-end="url(#lw-arrow-wf-e2e)"/>
  <path class="lw-edge" d="M 1316 386 H 1338" marker-end="url(#lw-arrow-wf-e2e)"/>
</svg>
</div>

## Document map

1. [Decisions](01-decisions.md)
2. [Target architecture](02-target-architecture.md)
3. [Workflow lifecycle](03-workflow-lifecycle.md)
4. [Plan and lane model](04-plan-and-lane-model.md)
5. [Safety and Git policy](05-safety-and-git-policy.md)
6. [Operations and notifications](06-operations-and-notifications.md)
7. [Skill changes](07-skill-changes.md)
8. [Future ACOS integration](08-acos-integration.md)
9. [Implementation roadmap](09-implementation-roadmap.md)
10. [Platform support](10-platform-support.md)

## Active, deferred, and excluded systems

| System | v1 status | Role |
|---|---|---|
| Claude Code | Active | Single user entry point and cognitive orchestrator |
| Laneward | Active | Central operational control plane |
| Agent | Active | Write worker; no Git authority. No default: `LANEWARD_AGENT` selects a preset (`codex`, `claude`) |
| Claude subagents | Active | Read-only research and review helpers |
| Dashboard | Active target | Operational inspection |
| Linux notifications | Active target | Attention and approval alerts |
| Windows | Active target | First-class platform alongside Linux (D-022) |
| macOS | Excluded | No path designed, documented, or verified |
| Verification layer | Decided, unbuilt | Independent clean run, then an advisory reader (D-028) |
| ACOS | Deferred | Not the audit layer; refactoring ACOS itself is a separate pilot (D-021) |
| GPT Pro handoff | Disabled | No active GPT Pro subscription |
| OMP | Excluded | Removed until separately measured and reconsidered |

## Non-goals

- Laneward does not replace Claude's reasoning.
- The agent does not create commits, branches, merges, or pushes.
- Obsidian is not part of project state management.
- OMP is not part of this architecture.
- GPT Pro is not a dependency.
- ACOS does not block the initial implementation.
