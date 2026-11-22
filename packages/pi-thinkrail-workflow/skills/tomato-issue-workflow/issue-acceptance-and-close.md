# 08 — Accept and close

Entry: delivery and acceptance evidence are collected. Save each criterion's actual status, explicit exemptions and any separately authorized body/close operation.

## Trigger and entry state

Use when updating the Issue body, assessing acceptance, or closing the Issue. A merge, passing CI or stage transition never implies close authorization.

## Automatic steps

1. List acceptance criteria and mark each observed complete, incomplete, unverified, skipped or explicitly exempt.
2. If body update is requested, read the complete current body and prepare a complete replacement; preserve unrelated labels/fields.
3. Run the explicitly requested body update through `issue_run_operation` without another questionnaire, bound to Issue identity, current-body snapshot and replacement. Re-read before writing; reject a changed snapshot and reread after success.
4. If close is requested, first verify provider capability and expose incomplete/unverified criteria and exemptions with the reason.
5. Run explicitly requested close through `issue_run_operation` without an extra confirmation or comment, bound to provider/instance/project/Issue, current state and reason; re-read before writing and read back closed state/time/receipt. Report closure only after that read-back confirms `closed`.

## Host capabilities

Use the installed host's advertised operation schema. `SKILL.md` owns legacy fallback only when the
direct tool is unavailable. Do not infer capability from a provider primitive. Report concrete gaps
and a tracked manual route; never bypass the host.

## Completion, questions and recovery

User acceptance of an exemption does not turn an unverified criterion into verified evidence. Concurrent body or Issue state changes invalidate the frozen operation and require refreshed facts and a refreshed operation within explicit intent. Uncertain writes require read-only reconciliation, never blind replay. A close refusal does not authorize a comment or prove the Issue remains open; report only the observed error and state. For generic `Invalid Issue request`, check the advertised schema and correct only a demonstrated mismatch; do not claim an unknown cause.

## Handoff

Report Issue acceptance and Issue closure as distinct states. After observed close read-back, or a documented capability blocker/manual path, return to the caller with the chat handoff and best-effort publication status under `SKILL.md`.
