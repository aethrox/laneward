# Workflow lifecycle

## State overview

<div class="lw-diagram lw-diagram--wide" markdown="0">
<svg viewBox="0 0 1100 660" role="img" aria-labelledby="wf-lifecycle-t wf-lifecycle-d">
  <title id="wf-lifecycle-t">Workflow lifecycle, by phase</title>
  <desc id="wf-lifecycle-d">Four phases. Plan holds Research and AwaitingPlanApproval, which can send the
  work back to Research to revise. Execute holds Executing, WaitingApproval and ReadyForReview, with
  returns for ambiguity and for a required correction. Integrate holds Integrated. Release runs
  ReleaseCandidate, RuntimeApproval, Deploying and Done, and a failed runtime verification sends the
  work back to WaitingApproval.</desc>
  <defs>
    <marker id="lw-arrow-wf-lifecycle" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path class="lw-arrowhead" d="M0,0 L7,3 L0,6 Z"/>
    </marker>
  </defs>

  <rect class="lw-band" x="0" y="60" width="1100" height="130"/>
  <rect class="lw-band lw-band--alt" x="0" y="190" width="1100" height="200"/>
  <rect class="lw-band" x="0" y="390" width="1100" height="120"/>
  <rect class="lw-band lw-band--alt" x="0" y="510" width="1100" height="130"/>
  <text class="lw-band-label" x="14" y="82">Plan</text>
  <text class="lw-band-label" x="14" y="212">Execute</text>
  <text class="lw-band-label" x="14" y="412">Integrate</text>
  <text class="lw-band-label" x="14" y="532">Release</text>

  <circle class="lw-dot" cx="125" cy="80" r="7"/>
  <path class="lw-edge" d="M 125 87 V 102" marker-end="url(#lw-arrow-wf-lifecycle)"/>

  <g class="lw-node">
    <rect class="lw-node-box" x="40" y="102" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="125" y="129" text-anchor="middle">Research</text>
  </g>
  <g class="lw-node lw-node--guard">
    <rect class="lw-node-box" x="320" y="102" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="405" y="129" text-anchor="middle">AwaitingPlanApproval</text>
  </g>
  <g class="lw-node lw-node--wait">
    <rect class="lw-node-box" x="40" y="227" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="125" y="254" text-anchor="middle">WaitingApproval</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="320" y="227" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="405" y="254" text-anchor="middle">Executing</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="880" y="227" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="965" y="254" text-anchor="middle">ReadyForReview</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="40" y="427" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="125" y="454" text-anchor="middle">Integrated</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="40" y="552" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="125" y="579" text-anchor="middle">ReleaseCandidate</text>
  </g>
  <g class="lw-node lw-node--guard">
    <rect class="lw-node-box" x="320" y="552" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="405" y="579" text-anchor="middle">RuntimeApproval</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="600" y="552" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="685" y="579" text-anchor="middle">Deploying</text>
  </g>
  <g class="lw-node lw-node--ok">
    <rect class="lw-node-box" x="880" y="552" width="170" height="46" rx="8"/>
    <text class="lw-node-label" x="965" y="579" text-anchor="middle">Done</text>
  </g>

  <path class="lw-edge" d="M 210 118 H 320" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <path class="lw-edge" d="M 320 132 H 210" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="265" y="150" text-anchor="middle">revise</text>

  <path class="lw-edge" d="M 405 148 V 227" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="415" y="184">approve</text>

  <path class="lw-edge" d="M 320 243 H 210" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="265" y="224" text-anchor="middle">ambiguity or</text>
  <text class="lw-edge-label" x="265" y="237" text-anchor="middle">external need</text>
  <path class="lw-edge" d="M 210 257 H 320" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="265" y="276" text-anchor="middle">approve and resume</text>

  <path class="lw-edge" d="M 490 250 H 880" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="685" y="240" text-anchor="middle">worker finished</text>

  <path class="lw-edge" d="M 930 273 V 300 H 440 V 273" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="685" y="316" text-anchor="middle">correction required</text>

  <path class="lw-edge" d="M 965 273 V 360 H 180 V 427" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="780" y="342" text-anchor="middle">Claude validates</text>
  <text class="lw-edge-label" x="780" y="355" text-anchor="middle">and commits</text>

  <path class="lw-edge" d="M 125 473 V 552" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="137" y="504">full checks pass</text>

  <path class="lw-edge" d="M 210 575 H 320" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="265" y="556" text-anchor="middle">audit gate</text>
  <text class="lw-edge-label" x="265" y="569" text-anchor="middle">passes</text>
  <path class="lw-edge" d="M 490 575 H 600" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="545" y="569" text-anchor="middle">approve</text>
  <path class="lw-edge" d="M 770 575 H 880" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="825" y="543" text-anchor="middle">runtime</text>
  <text class="lw-edge-label" x="825" y="556" text-anchor="middle">verification</text>
  <text class="lw-edge-label" x="825" y="569" text-anchor="middle">passes</text>

  <path class="lw-edge" d="M 685 552 V 336 H 20 V 250 H 40" marker-end="url(#lw-arrow-wf-lifecycle)"/>
  <text class="lw-edge-label" x="400" y="330" text-anchor="middle">verification fails</text>
</svg>
</div>

## 1. Intake and research

Every task begins in Claude Code.

Claude:

1. identifies the target repository and environment;
2. reads project instructions and `.laneward/project.json`;
3. reads current Laneward state;
4. performs read-only repository exploration;
5. uses read-only subagents when beneficial;
6. asks the user questions needed to eliminate material ambiguity.

No write lane is created during this stage.

## 2. Plan construction

The plan shown to the user contains at minimum:

- objective and expected user-visible outcome;
- assumptions and exclusions;
- lane list and dependency graph;
- owned paths for every write lane;
- expected tests for every lane;
- integration checks;
- network needs;
- external or destructive effects;
- real-environment verification;
- proposed concurrency;
- risks and rollback approach.

Claude explains the plan in plain language before requesting approval.

## 3. Approval and revision

Approval applies to a specific immutable plan revision.

If Claude changes material scope, it creates a new revision and asks again.

The approval record includes:

- plan ID;
- revision;
- timestamp;
- approved scope;
- risk summary;
- approved network and runtime effects;
- user decision.

## 4. Lane creation

Only after approval may Claude ask Laneward to:

1. create the integration branch;
2. create lane branches and worktrees;
3. register briefs, dependencies, and owned paths;
4. calculate dispatchability;
5. start eligible workers.

Laneward owns all write worktrees.

## 5. Worker execution

Each agent worker receives:

- one bounded goal;
- explicit owned paths;
- relevant context;
- prohibited actions;
- lane-level checks;
- escalation protocol.

A worker that needs new scope, unapproved network access, credentials, destructive effects, or host-level verification moves the lane to `waiting_approval`.

## 6. Review and commit

A successful agent exit is not proof of correctness.

When the worker exits, the conductor runs the project's lane checks and stores their results as lane evidence. Only then does Laneward mark the lane `ready_for_review`.

Claude then:

1. inspects the diff;
2. confirms only owned paths changed;
3. reads the recorded check results;
4. compares the result against the approved brief;
5. either requests correction or creates a focused commit.

Claude does not run the deterministic checks itself. Verification therefore keeps progressing while Claude Code is closed.

Only Claude creates the commit.

## 7. Integration

The lane commits of the plan's newest revision are merged onto:

```text
integration/<plan-id>-r<revision>
```

Not by Claude: D-032 builds the candidate with `bun run build-candidate <plan_id>`, and per issue #5 the conductor takes that over, so a candidate exists whether or not a session is open. The original wording here said Claude transfers the commits and named the branch `integration/<plan-id>-<short-name>`; a plan carries no short name, and the revision is what the candidate and its verification record are scoped to.

The full integration gate defined by the project then runs against the built tree.

A failed integration gate creates a new bounded correction lane or returns the relevant lane to work. It does not trigger an unapproved rewrite.

## 8. Release candidate

Until the verification layer is built, this stage consists of deterministic tests and Claude review.

The verification layer runs here, before merge, push, and installation: the independent clean run first, then the advisory reader, per D-028. ACOS is not part of it.

Findings are recorded and summarized non-technically. Findings never create correction lanes without user approval. The reader's findings advise and never block, per D-027, and an empty reader report is `no_findings` rather than a pass.

## 9. Merge, push, and runtime approval

Claude presents:

- the completed outcome;
- test evidence;
- remaining risks;
- verification-layer result when available;
- proposed merge and push;
- installation or runtime effects;
- rollback procedure.

The user explicitly approves merge, push, and real-environment effects.

## 10. Deployment and completion

The result is installed and verified against the project-specific runtime contract.

The plan becomes `done` only when:

- required code is integrated;
- approved merge and push are complete;
- installation succeeds;
- target behavior is observed;
- evidence is recorded;
- no unresolved blocking approval remains.

Lane worktrees and branches are then removed. The evidence, logs, and commits stay.
