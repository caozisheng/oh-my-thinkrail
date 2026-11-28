# GitLab Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a GitLab CLI auth status group that mirrors GitHub and appears between GitHub and Matrix on the Integrations page.

**Architecture:** Add a server-only `gitlab` module that probes `glab auth status` using the existing bounded subprocess helper. Add typed status and request contracts, wire handlers, a GitHub-shaped settings group embedded between the existing GitHub and Matrix groups, and locale keys. No new navigation section is needed.

**Tech Stack:** Bun, TypeScript, typed WebSocket contracts, React, Zustand, `@thinkrail/locales`.

---

### Task 1: Add the server GitLab auth probe

**Files:** `packages/server/src/gitlab/SPEC.md`, `index.ts`, `gitlab.ts`, `gitlab.test.ts`; `packages/server/src/host/handlers.ts`; server host imports/exports as required.

1. Add tests for parsing authenticated `glab auth status` output, unauthenticated/missing CLI graceful fallback, and refresh parity.
2. Run the focused GitLab server test and confirm the parser/module is missing.
3. Implement a `glab auth status` probe with the same bounded subprocess behavior as GitHub; never include token material in status.
4. Wire typed methods to the host handlers and verify the focused test passes.

### Task 2: Add the wire contract

**Files:** `packages/contracts/src/domain.ts`, `packages/contracts/src/wsProtocol.ts`, relevant contract tests and `packages/contracts/SPEC.md`.

1. Add a `GitlabAuthStatus` response type and `gitlab.authStatus` / `gitlab.refresh` methods.
2. Test the contract request/response mappings and run the focused contract suite.

### Task 3: Add GitLab Settings UI and locale copy

**Files:** `apps/web/src/panels/GitlabSettings.tsx`, `GitlabSettings.test.tsx`, `GithubSettings.tsx`, locale JSON files, `apps/web/src/panels/SPEC.md`, `apps/web/UI-TERMINOLOGY.md` as applicable.

1. Add tests for disconnected, connected, failed, loading, and refresh states, plus Settings ordering.
2. Implement the view with GitHub's status and refresh interaction, under GitLab-specific locale keys.
3. Embed the GitLab group after GitHub and before Matrix; retain existing navigation and route behavior.
4. Run focused UI tests and locale/lint checks.

### Task 4: Verify the combined change

Run targeted server, contracts, and web tests, then applicable fast gates (`bun run check:deps`, `bun run check:boundaries`, `bun run check:seams`, `bun run lint`, `bun run typecheck`). Review the task-scoped diff and subtract unnecessary abstractions.
