# Linked Repository State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Hide unnecessary workspace issue tags and hydrate linked repository buttons without user interaction.

**Architecture:** Reuse workspace binding metadata and existing per-issue repository RPCs. Keep async results scoped to the current issue refresh and connection identity, with per-issue request ordering.

**Tech Stack:** React, TypeScript, Bun tests, Playwright.

---

### Task 1: Workspace tags
- Update `apps/web/src/panels/workspaceIssueTag.test.ts` to expect null for primary bindings without associations; run `bun test apps/web/src/panels/workspaceIssueTag.test.ts` and observe failure.
- Return null for ungrouped bindings in `workspaceIssueTag.ts`, and suppress the span in `ProjectTree.tsx` when text is null.
- Update `apps/web/src/panels/SPEC.md` and rerun the test.

### Task 2: Repository hydration
- Add browser regression coverage in `e2e/issues-repositories.spec.ts` for first-load linked state and changed state after refresh without opening the control. Verify failure before changing production code.
- In `apps/web/src/issues/IssuesTool.tsx`, initiate repository reads for loaded issues after a current successful list refresh. Scope displayed data to identity, reject stale reads, preserve last confirmed state while reading, and keep popover retries.
- Update `apps/web/src/issues/SPEC.md` and rerun focused issue tests and browser coverage.

### Task 3: Integration gates
- Run affected unit tests, web typecheck, lint and boundary gates, plus `bun run e2e` once for the integrated runtime change.
- Review the task-local diff, comments, README claims and avoid unnecessary abstractions. Preserve unrelated pre-existing design document edits.

### Task 4: PR
- Commit only task-scoped files, push the branch to origin, create a PR against main and monitor CI. Repair failures attributable to this change and report any environmental blockers honestly.
