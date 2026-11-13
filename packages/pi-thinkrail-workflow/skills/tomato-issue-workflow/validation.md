# 04 — Validate exact changes

Entry: implementation changes are ready for verification. Save checks and their evidence classification against the exact checkout; route to `draft-delivery.md` only when delivery prerequisites are met.

## Trigger and entry state

Use before reporting implementation completion or preparing delivery, and after any commit/tree change that may invalidate prior evidence.

## Automatic steps

1. Read repository, worktree, branch, HEAD, tree and staged/unstaged/untracked status.
2. Read the repository's CI configuration to identify actual commands, runner and platform.
3. Run applicable focused checks and bind each result to exact commit/tree, target, tool version and platform when observable.
4. Classify every check as passed, failed, skipped, not run, not applicable or environment-limited.
5. After any commit, merge, conflict resolution or dependency/lockfile change, assess which evidence is invalid and rerun affected checks.

## Host capabilities

The current workflow may run local checks and read CI/provider facts, but validation is not presumed durable host evidence unless an explicit host record says so. Do not claim a lockfile/frozen install validates a committed tree when uncommitted dependency changes were present.

## Completion, questions and recovery

Only evidence matching the delivery tree counts for that tree. Do not report unchecked platforms or skipped checks as passing. If required commands or platforms cannot run, state the limitation and ask only when a user decision is needed to proceed.

## Handoff

Route to `draft-delivery.md` with the exact commit and validation classifications; route changed cross-repository trees back through `cross-repository.md` as needed.
