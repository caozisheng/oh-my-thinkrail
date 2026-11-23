---
id: submodule-server-matrix
type: submodule-design
status: active
title: matrix — host-owned Matrix integration
parent: module-server
depends-on: [module-contracts]
tags: [integration, matrix]
---

## Responsibility

The host-owned Matrix bot lifecycle, private Space/room projection and single-controller message
bridge. Host composition supplies catalog, transcript and control ports; pi remains the only agent
runtime and transcript owner. Matrix room names and state never confer host authority.

## Boundary

- **Owns:** SDK clients, authentication and integration operation state; stable host-ID mappings,
  projection receipts and Matrix event consumption records.
- **Public surface:** service and bridge factories and their injected ports through `index.ts`.
- **Allowed deps:** `matrix-js-sdk`, `contracts`, `shared/codedError`, Node built-ins. Host injects
  persistence, vault and project/agent operations; the module imports no feature siblings.
- **Forbidden:** importing `host`, `web`, launchers, or another agent runtime; deriving host session
  state from Matrix room names/events; writing pi transcripts directly; accepting control authority
  from room membership, display names or room metadata; persisting passwords or access tokens outside
  the OS credential vault.

## Bridge invariants

Only the configured full controller MXID can submit input in locally mapped rooms. Other members
may read but are configured without message-send permission. New rooms are private and invite-only;
encrypted rooms fail closed. Automatically map working/needs-input sessions in open trusted projects;
explicit history mapping uses stable session IDs, never display-name matching. Closing a project
pauses its existing mapping without deleting Matrix history or host entities. Controller changes do
not revoke historical Matrix content access.

Consume the initial sync as a baseline, never execute its timeline. On reconnection, discard backlog
and ask the controller to resend. Persist a dispatch fence before any host control call. A restart
with an unfinished fence is an unknown delivery, never an automatic replay. Output projections use
stable transaction IDs and are reconciled from the complete host display transcript. Thinking and
arbitrary tool input/output are excluded. Host capability ports recheck project trust and exact
session/run/interaction identity immediately before side effects. No bridge action changes web focus.

## Get right

Configuration accepts an HTTPS homeserver origin only, and every request is pinned to a resolved
public address for that origin, bounded and redirect-free. The SDK's default logger is disabled because
its diagnostics can contain authorization URLs. Tokens are stored only in the OS vault; disk metadata
contains a credential UUID and closed operation fence, never passwords or access tokens. The bot's
initial sync is a baseline; controller events from that batch and all offline backlog are never run.

Project/session mappings use stable host ids. Transcript projections use stable Matrix transaction ids
and exclude thinking, tool output and ThinkRail control messages. A dispatch fence is persisted before
prompt/answer/stop; after restart, an unfinished dispatch is unknown and is never replayed. The host
rechecks project trust, openness, workspace ownership and current run/interaction identity before control.

matrix-js-sdk is licensed Apache-2.0 and declares Node.js >=22 support. Bun import, server typecheck,
CLI bundling and an SDK `/sync` lifecycle against an injected homeserver fixture have been exercised.
Element/mobile UI behavior and real homeserver variants still require user verification.
