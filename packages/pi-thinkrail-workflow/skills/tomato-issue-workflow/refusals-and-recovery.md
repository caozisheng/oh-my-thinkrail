# 10 — Refusals and recovery

Entry: a host/provider operation may have been dispatched without a definitive result. Save the observed state and next action; return to the owning use case only when safe. A clear pre-execution refusal is reported, not turned into a recovery workflow.

## Trigger and entry state

Use only when dispatch or remote outcome is uncertain and recovery is needed for the requested operation. Unavailable or uncertain summary publication follows the best-effort ending in `SKILL.md`; do not enter recovery or ask for authorization merely to end the session. Clear preparation/execution refusals are reported directly unless the host supplies a specific correctable cause.

## Automatic steps

1. Read the host result. For `confirmation_mismatch`, inspect the original operation: if it remains prepared and no mutation was dispatched, fix the call-to-receipt binding and execute the already-authorized operation without another user prompt. If dispatch may have occurred, inspect remote state and use receipt-backed recovery. For other clear pre-execution refusals, report the cause and correct the identified input/policy issue before running a corrected operation; do not ask the same question without a material change.
2. For `Invalid Issue request` or another generic preparation rejection, first audit the request against the chosen action's advertised schema and operation contract: action, required and forbidden fields, field meanings, and authoritative ID source. Correct only a demonstrated request mismatch, refresh facts and prepare again with a fresh operationId if no intent was reserved. Do not claim a specific cause when the host did not identify one.
3. Do not treat repeated generic rejection as evidence that the capability is unavailable, that the gate is too strict, or that a particular field caused the refusal. State that the cause is unknown unless the host provides a specific reason.
4. For safe local/readonly conditions within existing authorization, correct the cause, refresh facts and rerun preflight. `delivery-state-incomplete` means repository registration is incomplete, not that upstream merge evidence was inspected or compatibility failed: use `cross-repository.md`'s registration recipe. Classify missing MR identity separately from absent compatibility configuration, failed checks and stale versions; never tell the user that repeating an MR link will synchronize state.
5. Inspect the existing operation with its original operationId. Read remote state only when dispatch may have occurred; a prepared/no-dispatch result can proceed without another user prompt.
6. Adopt an observed result only through the host's advertised receipt-backed recovery capability; do not invent a recovery path. If unavailable, stop and report the uncertainty. A failed mutation authorizes no separate comment or other Issue write; do not infer remote state from a refusal.

## Host capabilities

Preparation rejection before intent reservation is distinct from uncertain execution. `inspect:true` is available only for operations and input shapes accepted by its contract; it is not a general diagnostic endpoint, and action-specific reads are not substitutes for inspecting a rejected stage request. The host's inspect/reconcile support is authoritative; no shell, direct API, replacement ID or hand-edited journal recovery is allowed.

## Completion, questions and recovery

Never classify service unavailability as an authorization error without evidence. A generic `Issue tools are unavailable for this session` cannot identify a particular lost binding, trust failure or provider outage by itself. It also does not disable ordinary repository tools or withdraw the user's repository-work authorization: isolate the failed Issue action and continue unrelated repository work through its normal workflow; it does not require session-wide recovery. A plain diagnostic chat does not inherit another chat's Issue association; report that distinction without rebinding sessions or modifying journals. Do not repeat a mutation after possible dispatch. Fix receipt-binding errors without a redundant user prompt when the journal confirms the operation is still prepared; for a real authorization/payload change, refresh the operation within explicit intent. Ask only for genuinely missing user intent, not to diagnose a host bug. If an uncertain remote outcome cannot be reconciled, state the exact blocker and offer a practical manual path rather than implying all submission is impossible.

## Handoff

When resolved, return to the owning use case with fresh facts. Otherwise return a partial/blocked chat handoff naming failure phase, observed evidence, what was not run and the next safe action; use `SKILL.md`'s best-effort publication, never a recursive summary-recovery gate.
