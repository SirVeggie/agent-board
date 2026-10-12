# Auto-review approval timeout decision (#287)

Design only; runtime implementation is outside this card's stated scope.
The preference form `scribe:approval-timeout-model-decision` contains a saved
initial wait of 1,200 seconds (20 minutes), read on 2026-10-12.

## Required behavior

Start the initial timer only when an eligible human permission request becomes
visible. On expiry, return an explicit `unanswered_timeout` result to the model
with the scoped action, approval rationale, request identity and two choices:
wait for the human indefinitely, or abandon this request and use a permitted
alternative. Expiry never grants permission or represents a human refusal.

Waiting requires a visible explanation of why the action matters to the user's
goal. Retain one prompt for the scoped action, without starting another initial
timer. Waiting does not change mode, sandbox, tool permissions or review policy.
Abandoning invalidates the request before alternative work proceeds. A later
approval of that request must not run or retry the abandoned action.

## Capability gate

Eligibility must be declared per provider and tool surface, rather than inferred
from provider names, Auto-review support, or automatic approve/deny behavior.
An eligible surface needs all of:

- A human request/reply bridge with a stable scoped request identity.
- A way to return an unanswered result to the model without executing the action.
- A model-callable way to choose waiting or abandonment for that request.
- Cancellation and invalidation of abandoned requests, including late replies.

Unsupported surfaces retain their existing behavior. Native tools and host-run
tools may have different capabilities within the same provider.

## Current implementation findings

`src/agent/providers/provider.ts` exposes `RunSink.approval`, whose decision only
contains `optionId` and an optional note. It does not declare a timeout outcome
or a per-surface approval timeout capability. Adding a synthetic rejection
option alone would lose the distinction between no answer and user refusal.

`src/agent/host.ts` creates a pending approval item and waits for its answer.
`resolveApproval` removes that pending identity before resolving it, and rejects
answers for missing identities. Preserve that single-consumer behavior in the
expanded lifecycle.

`src/agent/providers/codex.ts` has a human bridge for Auto-review denials through
`approveReviewDenial`. Human approval requests one retry through
`thread/approveGuardianDeniedAction`; it still goes through Auto-review. This is
evidence of a human bridge, not proof that the surface can return an unanswered
timeout to the model and accept its subsequent wait/abandon choice. That part
needs a provider-specific integration before enabling this feature.

## Lifecycle and verification plan

Use atomic state transitions keyed by request identity and owning turn/session:
`initial_wait -> model_choice -> indefinite_wait`, or `model_choice -> abandoned`.
Human answers can resolve any live waiting/choice state. Approved, refused,
cancelled and abandoned are terminal. An answer processed first wins over a
queued timeout or model choice; cancellation or refusal processed first prevents
any later execution. Clear timers/listeners when the request becomes terminal.

Verify with controlled timers and a fake provider bridge:

- No answer after 20 minutes delivers action/rationale and unanswered outcome.
- Wait choice preserves one prompt, displays a reason and has no further timeout.
- Abandon choice invalidates the request; a late approval never executes.
- Answer before expiry clears the timer and retains the original human decision.
- Answer racing with expiry or model choice settles once and executes at most once.
- Explicit refusal, stop, tool abort and session replacement remain authoritative.
- Unsupported surfaces and non-Auto-review policies keep their existing behavior.
- Mode/sandbox restrictions remain in force, including on an approved retry.

The linked form asks whether the next task should implement this design or keep
it as a specification, because the card currently says no implementation.
