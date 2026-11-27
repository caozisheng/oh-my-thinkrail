# 03 — Design and implement

Entry: Issue identity and requested stage are verified. Save the design/implementation outcome and unresolved stage-record status; route to `validation.md` after implementation, or return the design handoff to the caller.

## Trigger and entry state

Use for an explicit design or implementation stage. Design is design-only. Implementation begins from its explicit launch without requiring a design-stage receipt or approval label.

## Automatic steps

1. For design, follow the existing `brainstorming` workflow and stop before implementation; return here for Issue handoff.
2. For implementation, reuse the existing plan/TODO mechanisms, inspect owning specs and code, and implement the confirmed requirements.
3. Keep durable decisions in owning specs when boundaries, contracts or documented behavior change.
4. Verify and self-review the implementation. Do not assume a stage update succeeded because work is complete.
5. Evaluate implementation delivery readiness independently of stage publication.
6. Before stage reporting, read the calling contract below. For preparation rejection or uncertain execution, follow `refusals-and-recovery.md`; do not change action or IDs by trial and error.

## Host capabilities

Stage reporting uses its own host operation and durable journal. Provider stage labels are records, not authority for code correctness or delivery. Current server support is governed by the Issues module contract; do not infer unavailable lifecycle features from stage support.

## Operation calling contract

The tool's optional fields describe several different operations, not one combinable payload. Match the installed host contract; use advertised `issue_run_operation` with the same payload shape as
`issue_prepare_confirmation`; `SKILL.md` owns legacy fallback only when unavailable:

- Stage report: `issue_run_operation({operationId, report})`. **Omit `action`**; the bound session determines design versus implementation. Do not send `projectId`, `expectedRevision`, `expectedSha` or a custom `deliveryState` as a stage report.
- Journal inspection: `issue_prepare_confirmation({operationId, inspect:true})` using the original operationId. Omit `action`, `projectId` and the report/state fields; this inspects the operation journal, not general host health.
- Remote MR/CI inspection: `issue_prepare_confirmation({operationId, action:"ready-mr" | "merge-mr", inspect:true, projectId, mergeRequestId, expectedSha?, targetBranch?})`. This is read-only and returns the bound provider's current MR identity/state, head SHA, target SHA, pipeline and readiness facts; it does not prepare a confirmation or mutate the MR. Use the local repository id from fresh `issue_context` for `projectId`.
- Delivery-state read: `issue_prepare_confirmation({operationId, action:"read-delivery-state"})`; do not add `inspect:true` or `projectId`.
- Delivery-state write: `issue_prepare_confirmation({operationId, action:"record-delivery-state", expectedRevision, deliveryState})` using the host-defined state structure and observed revision. This is not stage confirmation; never invent a `{stage, status, summary}` replacement.
- Dependency preflight and lifecycle automation policy/read operations remain on `issue_prepare_confirmation`; `issue_run_operation` is only for the actual requested Issue mutation.
- For operations that require `projectId`, use the local repository binding from fresh `issue_context`, not the provider Issue reference's project id. These are different namespaces even when both are strings.

Use only the fields for the intended operation; a schema-valid superset can still violate host validation. Stage preparation uses a fresh unique operationId; inspection and uncertain-write recovery preserve the original. Run explicit intent directly without another questionnaire; only legacy fallback uses the actual submitted receipt as described in `SKILL.md`.

## Completion, questions and recovery

Design approval in the request covers only the design; it does not authorize implementation in a design session. Implementation launch needs no second design gate. Clarify conflicts or changes to agreed design. For a refused or uncertain stage write, use `refusals-and-recovery.md`; preserve the original operationId while inspecting it or recovering an uncertain write. A corrected preparation may use a new ID only after confirming no intent was reserved.

## Handoff

Design: attempt a concise Issue handoff and return to the caller; summary publication is best-effort under `SKILL.md`. Implementation: route to `validation.md` and `stage-delivery-decoupling.md`; do not let a failed stage record block separately eligible delivery.
