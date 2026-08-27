# Operations and notifications

## Service model

The target installation uses systemd user services.

Expected responsibilities:

- Laneward API starts automatically;
- the dashboard is available with Laneward;
- worker supervision reacts to approved dispatchable lanes;
- notification delivery starts automatically;
- services restart according to bounded systemd policy;
- runtime data remains under user-owned state directories.

The current conductor drains lanes and exits. Converting it into continuously supervised work requires a deliberate design. A tight polling loop should not be added casually.

Possible target designs:

1. a supervised worker that blocks on a queue or database notification;
2. a lightweight timer that invokes the existing drain command;
3. a long-running conductor with bounded polling and lease ownership.

The implementation phase must compare these against the current recovery model.

## Claude-independent execution

After a plan is approved:

- eligible agent lanes may continue when Claude Code closes;
- workers never commit;
- the conductor runs the project's lane checks when a worker exits and stores the results;
- checked work becomes `ready_for_review`;
- Claude reviews it after the next session starts;
- the session-start bridge presents all pending review and approval items.

This keeps execution independent without delegating integration judgment to workers.

## Crash and reboot recovery

A reboot or kill may leave a lane marked `running`.

Recovery must:

1. determine whether a worker process still exists;
2. verify lease ownership;
3. preserve the worktree and logs;
4. avoid unconditional duplicate execution;
5. mark the lane recoverable or require operator approval;
6. resume only after the state is consistent.

The existing unconditional `reset-stranded` behavior is useful as a manual tool but is not sufficient for automatic recovery.

## Dashboard

The dashboard is the complete operational view.

It should expose:

- active plans and revisions;
- approved and awaiting-approval plans;
- lane dependency graph;
- running and blocked lanes;
- ready-for-review lanes;
- failures and retry history;
- evidence and logs;
- integration status;
- runtime approval state;
- completed plans.

The initial approval still occurs in Claude Code. Dashboard mutation controls may be added later.

## Linux desktop notifications

Notifications are reserved for events that require attention:

- user approval required;
- lane failed;
- all lanes are ready for review;
- runtime verification is required;
- plan is fully complete.

Routine progress remains in the dashboard.

Notifications should include:

- project and plan name;
- concise plain-language reason;
- urgency;
- a safe command or dashboard location for details.

They must not contain secrets, large logs, or misleading "done" claims.

## Notification reliability

A notification is not the source of truth. Missing or dismissed notifications do not change Laneward state.

Laneward records whether delivery succeeded. A failed delivery is not retried, and a NULL `delivered_at` means the desktop command did not exit 0.

On the next Claude session, pending items are loaded from Laneward regardless of notification delivery.

## Observability

Minimum operational evidence:

- plan and revision IDs;
- lane IDs;
- worker start and finish times;
- worker exit results;
- approval transitions;
- check names and outcomes;
- commit SHA created by Claude;
- integration result;
- runtime evidence;
- recovery actions.

Logs should be useful for diagnosis without becoming a second database of duplicated state.
