# Future ACOS Integration

> **Superseded in its central claim by D-028.** ACOS is not Laneward's
> independent verification layer. It was run twice against a real change in the
> bake-off (issue #4) and produced
> nothing usable: it cannot spawn its agents on this host, its output contract
> does not survive this host's agent configuration, and it reviews a whole
> exported revision rather than a change. The first two are fixable; the third is
> what it is designed to be. The layer is instead an independent clean run
> followed by an advisory reader.
>
> What survives here is the ordering below and the pilot framing: refactoring
> ACOS through Laneward remains a possible second pilot, per D-021. Read
> everything below as ACOS's own roadmap, not as Laneward's audit plan.

## Current status

ACOS is incomplete. It must not be treated as a production dependency or block Laneward v1.

The correct order is:

1. stabilize the Laneward workflow;
2. run a real pilot;
3. use Laneward to refactor ACOS;
4. specialize ACOS for Laneward release-candidate audits;
5. enable it gradually.

## Intended role

ACOS becomes a final independent audit layer, not a general control plane.

Its question is:

> Is this integrated release candidate sufficiently verified and safe to propose for merge, push, and installation?

ACOS does not replace:

- lane tests;
- Claude review;
- integration tests;
- runtime smoke tests;
- user approval.

## Placement: option B

ACOS runs after code and integration checks are complete, but before merge, push, and installation.

```text
Implementation complete
→ Integration checks pass
→ ACOS audit
→ User receives plain-language result
→ Merge/push/runtime approval
→ Installation
→ Runtime smoke verification
→ Done
```

Running the first audit only after installation would discover serious defects too late.

## Dynamic reviewer and verifier roles

Roles change according to the task and who produced the change.

Examples:

| Change producer | Reviewer | Verifier |
|---|---|---|
| Codex | Claude | Deterministic tests or independent Codex |
| Claude-authored change | Codex | Deterministic tests |
| Multiple workers | Claude | Codex |
| Linux service | Claude | Service and smoke-test evidence |
| High-risk architecture | Claude and approved specialist | Codex plus deterministic checks |

The same agent/session should not be accepted as the only independent verifier of its own work.

## Finding behavior

When ACOS finds a problem:

1. store the finding in `reports/acos/`;
2. link it to the Laneward plan and integration revision;
3. classify severity and confidence;
4. explain user impact in non-technical language;
5. move the plan to an approval-waiting state;
6. ask the user whether a correction lane should be created.

ACOS must not automatically modify code or create correction lanes.

## Adoption stages

### Stage 0: Disabled

Laneward v1 operates without ACOS.

### Stage 1: Shadow mode

ACOS runs but does not block release. Its findings are compared with known defects and human review.

### Stage 2: Advisory gate

ACOS findings require acknowledgment, but the user decides whether they block.

### Stage 3: Blocking gate

Only evidence-backed high-severity classes block release automatically. This stage requires a measured false-positive and false-negative history.

ACOS must prove value before it receives blocking authority.

## Open questions (to revisit)

- **sol-advisor comparison (2026-08-08):** the `DannyMac180/sol-advisor` plugin
  implements a single, user-pinned, fail-closed "advisor" role that verifies
  diff/evidence before acceptance, with an explicit "behaviorally read-only
  unless the client exposes evidence of OS-enforced isolation" guarantee (it
  reports the observed guarantee rather than assuming one). ACOS's dynamic
  reviewer/verifier model is broader in scope than that single role, but the
  read-only-guarantee wording and the fail-closed model-binding pattern may be
  useful reference material when ACOS's reviewer/verifier assignment is
  actually implemented. Revisit when ACOS moves past Stage 0.
