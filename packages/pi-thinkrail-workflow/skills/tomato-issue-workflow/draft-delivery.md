# 05 — Draft delivery

Entry: exact repository, source/target branches, commit, validation evidence and applicable delivery authorization are known. Save push/request state and receipt; route to `ready-and-merge.md` only when separately authorized.

## Trigger and entry state

Use for a requested Draft PR/MR push/create/update. A stage label or stage-report receipt is not a delivery prerequisite.

## Automatic steps

1. Read fresh repository identity, source/target branches, commit and provider capability facts.
2. Check for the same active request and verify repository, source and target identity before reuse.
3. Run the requested delivery through advertised `issue_run_operation` without another questionnaire; use legacy fallback in `SKILL.md` only if unavailable.
4. Push only the authorized exact commit, non-force by default; create a Draft request or update the matching active request, never a duplicate.
5. Read back request identity, target and head SHA; report creation/update and CI state separately.

## Host capabilities

The host delivery operation covers ordinary non-force push and Draft PR/MR create/reuse/update. It does not grant ready, merge, close or Issue-body update. Check actual provider support before promising the full lifecycle.

Only for an explicitly requested update of an existing opened same-repository PR/MR after rebasing,
run `pushMode: "force-with-lease"` with exact delivery inputs. Explicit intent is sufficient, without
independent high-risk confirmation. The host freezes the canonical remote/ref, old SHA and replacement
SHA. Missing heads, forks, request/head disagreement and concurrent updates are hard refusals. Never
use implicit leases, unconditional force, shell bypass or automatic retry. This mode cannot create a
request and must not be selected autonomously.

## Completion, questions and recovery

A completed stage record is not proof of delivery, and a failed stage record does not block independently eligible delivery. Changed repository, branch, request or commit invalidates the frozen operation. Do not adopt a request that appeared after the operation snapshot. For refusals or uncertain dispatch, follow `refusals-and-recovery.md` under the original operationId; never blindly resend.

## Handoff

Report committed, pushed, request-created/updated, CI and stage-record states separately. Route to `ready-and-merge.md` only with applicable authorization; route CI repairs through `validation.md` before a later delivery operation.
