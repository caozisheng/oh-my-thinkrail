# 10 — Refusals and recovery

Entry: a host/provider operation was refused, failed or may have been dispatched without a definitive result. Save the classified failure phase, evidence and next action; return to the operation's owning use case only when safe.

## Trigger and entry state

Use for deterministic preflight rejection, provider outage, execution refusal, delayed receipt or uncertain remote write.

## Automatic steps

1. Read the exact host reason code and failure stage; distinguish preflight, service unavailable, not dispatched, confirmed success and uncertain dispatch.
2. For `Invalid Issue request` or another generic preparation rejection, first audit the request against the chosen action's advertised schema and operation contract: action, required and forbidden fields, field meanings, and authoritative ID source. Correct only a demonstrated request mismatch, refresh facts and prepare again with a fresh operationId if no intent was reserved.
3. Do not treat repeated generic rejection as evidence that the capability is unavailable, that the gate is too strict, or that a particular field caused the refusal. State that the cause is unknown unless the host provides a specific reason.
4. For safe local/readonly conditions within existing authorization, correct the cause, refresh facts and rerun preflight.
5. For uncertain dispatch, inspect the existing operation and read current remote state; retain its original operationId.
6. Adopt an observed result only through the host's receipt-backed recovery capability and its real user confirmation.

## Host capabilities

Preparation rejection before intent reservation is distinct from uncertain execution. `inspect:true` is available only for operations and input shapes accepted by its contract; it is not a general diagnostic endpoint, and action-specific reads are not substitutes for inspecting a rejected stage request. The host's inspect/reconcile support is authoritative; no shell, direct API, replacement ID or hand-edited journal recovery is allowed.

## Completion, questions and recovery

Never classify service unavailability as an authorization error without evidence. Never repeat an operation merely because an error, timeout or absent comment was observed. Ask the user only for the specific missing identity, policy, permission or recovery confirmation. If the host lacks safe recovery, name that missing capability and stop.

## Handoff

When resolved, return to the owning use case with fresh facts. Otherwise publish a partial/blocked Issue handoff naming failure phase, observed evidence, what was not run and the next safe action.
