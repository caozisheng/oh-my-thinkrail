# 07 — Pair repositories

Entry: an explicit repository dependency order and target branches are known. Save upstream merge evidence and downstream pairing/validation results; route each downstream repository through its normal validation and delivery path.

## Trigger and entry state

Use when a task changes or delivers more than one repository with an API, ABI, protocol, shared dependency or lockfile relationship.

## Automatic steps

1. Build the upstream → downstream dependency order and freeze each repository's worktree and target. First follow the registration recipe below; notes in a plan or a supplied MR URL do not populate host state.
2. Validate and deliver the upstream repository under its own policy.
3. Read the actual upstream target branch SHA after merge; never substitute source-branch HEAD.
4. Before changing downstream pairing/lock data, inspect target SHA, ancestry, compatibility and likely conflicts.
5. Resolve any conflict, update pairing only after checks, and rerun affected validation on the final downstream tree.

## Register and refresh delivery state

Use `issue_prepare_confirmation` by its advertised schema:

1. Read `{operationId, action:"read-delivery-state"}`. Its `participating` list supplies host-observed worktree IDs, branch, SHA and tree; `revision` is the CAS token.
2. Record `{operationId, action:"record-delivery-state", expectedRevision:revision, deliveryState:{repositories:[...]}}`. Include **every** participating repository, each with `projectId`, `worktreeId`, `sourceBranch`, selected `targetBranch`, `policy`, `dependsOn` (local project IDs), `checkoutSha`, `checkoutTree`, `validations` and ISO `updatedAt`. Map the observed `branch/sha/tree` to those checkout fields. Use `validations:[]` absent applicable checks; never invent results. Select policy and dependency order from agreed intent, not a default inference.
3. For an upstream MR, add `mergeRequestId` (the IID from its URL/receipt) to that repository's metadata. The host fetches and verifies the MR; supplied state, SHA or URL is not merge evidence. Refresh registration after new repositories join or checkout/target changes. Read again on revision conflict; never overwrite concurrent decisions or erase extra repository history.
4. Call `{operationId, action:"preflight-dependencies", projectId:downstreamLocalProjectId}` before pairing changes and again on the final downstream tree. The host reads actual upstream merge/target facts and executes configured compatibility checks. Registration itself grants no push, merge or evidence authority.

## Host-executed compatibility checks

The trusted downstream worktree must contain `.thinkrail/issue-compatibility.json`, version `1`, an argv `command` array (no shell interpolation), bounded `timeoutMs`, and `coverage` for `api`, `abi`, `protocol`, `conflict`, `checks`; each is `checked` or explicitly `not-applicable`, with at least one checked. The command must actually validate its declared coverage against the exact JSON version context supplied in `THINKRAIL_ISSUE_COMPATIBILITY_CONTEXT`. Exit zero records host-observed success only for that context; failure, timeout, configuration changes and checkout/upstream movement refuse the preflight. Do not add a no-op command or mark a relevant dimension not-applicable to pass a gate. Establish the project's real validation command with the user when not already specified.

## Host capabilities

Repository membership and Git/provider reads do not establish ABI/protocol compatibility. The host does not infer compatibility from independent CI success. A merge preview detects conflicts but is not final verification.

## Completion, questions and recovery

Do not update downstream locks when upstream target SHA or compatibility is unknown. For `delivery-state-incomplete`, repair registration first; it does not mean merge SHA or compatibility checks ran. For `missing-upstream-request`, register the upstream IID. Missing compatibility configuration requires a real project check, not another copy of the MR link or a request to magically synchronize host evidence. Follow `refusals-and-recovery.md` for other refusals. Ask for technical/user decisions only where required; report a concrete blocker otherwise. A changed upstream target invalidates dependent pairing evidence.

## Handoff

Route downstream changes to `validation.md`, then `draft-delivery.md`. Return to the caller with per-repository target and observed SHA evidence.
