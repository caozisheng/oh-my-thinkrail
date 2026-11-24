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
runtime and transcript owner. Matrix room names and state never confer host authority. Initial mapping
covers active/needs-input sessions in open trusted projects; the standard control room lists other
readable sessions for exact-ID user-initiated mapping.

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

Only the configured full controller MXID can submit input in locally mapped rooms. For a live, mapped
session-room text event, the bridge sends a standard `m.read` receipt after fresh room/session checks
and before the host control call. Receipt failure is isolated and never prevents dispatch; historical,
edited, duplicate, control-room and unauthorized events do not receive this acknowledgement. Other members
may read but are configured without message-send permission. Controller and former-controller power
levels are written together as one full state event built from fresh room state; sequential SDK
power-level updates can overwrite each other from a stale cache. Unchanged levels produce no write. New rooms are private and invite-only;
encrypted rooms fail closed. Automatically map working/needs-input sessions in open trusted projects;
explicit history mapping uses stable session IDs, never display-name matching. Closing a project
pauses its existing mapping without deleting Matrix history or host entities. Controller changes do
not revoke historical Matrix content access.

Consume the initial sync as a baseline, never execute its timeline. Once the SDK reports that its
initial batch is prepared, later controller messages are live even if room/transcript reconciliation is
still running. One serial projection owner admits them between awaited reconciliation steps
(catalog, root/control/project/session setup, transcript read, and transcript message delivery and non-stream text chunks),
not behind an entire multi-session pass. A checkpoint releases ownership only after its work settles;
never race or detach an uncancelled operation. Concurrent reconcile requests join the same pass.
An in-flight SDK/host operation can still delay input until the next checkpoint. On reconnection,
discard the first successful response batch as historical and ask the controller to resend. The SDK
emits timeline events before its per-batch Syncing state event, so the first successful batch after a
reconnect remains historical; events from the next batch are admitted. The SDK does not expose enough
metadata to distinguish deeper backlog from newly arrived events. Persist a dispatch fence before any host control call. A restart
with an unfinished fence is an unknown delivery, never an automatic replay. Output projections use
stable transaction IDs and are reconciled from the complete host display transcript. Host message
snapshots drive realtime assistant output, coalesced to approximately one update per second. The first
snapshot creates a bot message; later snapshots replace that same message via standard `m.replace`,
and message completion flushes a final update. Persisted original event IDs and revision transactions
repair unknown sends without duplicating the final transcript. Assistant identity includes timestamp
occurrence so same-millisecond messages remain distinct. Thinking and arbitrary tool input/output are
excluded. Only host settlement with no remaining background work emits a completion notice. Host capability ports recheck project trust and exact
session/run/interaction identity immediately before side effects. No bridge action changes web focus.

Reconciliation configures each project once per pass and excludes unmapped inactive sessions before
project setup. Finalized unchanged stream receipts bypass expensive catalog and room checks because
no side effect occurs; pending delivery recovery and actual sends retain fresh authority checks.

Inbound diagnostics use only closed classification codes injected by the host. They distinguish SDK
sync state, timeline filtering, queue admission, room mapping and host dispatch outcomes without
recording event payloads, identifiers, account names, endpoint URLs or raw errors. Diagnostic consumer
failures cannot change delivery behavior.

## Get right

Configuration defaults to HTTPS/public DNS. A v144 explicit acknowledgment may authorize HTTP and
private-network DNS for one exact canonical homeserver origin. Requests remain pinned to fresh DNS
answers and reject loopback, link-local, metadata, redirects and other origins. Consent authorizes
public and supported private DNS answers for that exact origin, not a permanent IP allow-list.
Changing the exact endpoint requires new consent. The SDK's
default logger is disabled because
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
