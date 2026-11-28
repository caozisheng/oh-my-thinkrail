---
id: submodule-server-gitlab
type: submodule-design
status: active
title: gitlab — local glab auth status
parent: module-server
depends-on: [module-contracts, submodule-server-subprocess]
tags: [host, public-surface-checked]
---

## Responsibility

Read-only local GitLab CLI (`glab`) auth status for Integrations Settings. The host shells out to
`glab auth status` through `runBounded`; missing, unauthenticated, non-responding and offline probes
resolve to `{ connected: false }`. Status exposes only whether the CLI is authenticated, never account
or token material. Refresh repeats the same probe.

## Boundary

- **Public surface (barrel):** `gitlabAuthStatus`, `gitlabRefresh`, `parseGlabAuthStatus`.
- **Allowed deps:** `contracts` (`GitlabAuthStatus`); `subprocess` (`runBounded`).
- **Forbidden:** `host`, sibling features and browser bundling.
