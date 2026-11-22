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

The local host's Matrix bot connection and its projection of ThinkRail projects and sessions into
standard Matrix Spaces and rooms. Matrix is an external messaging surface, never the source of truth
for project, workspace, session, transcript or agent state. The host remains the only pi runtime.

## Boundary

- **Owns:** Matrix SDK client lifecycle, bot credential reference, stable host-ID-to-room mappings,
  durable Matrix event deduplication and projection cursors, and Matrix-specific command parsing and
  formatting.
- **Public surface:** a server-only barrel for host composition; Matrix credentials and SDK objects
  never cross the contracts wire.
- **Allowed deps:** `contracts` for Matrix DTOs, `persistence` for integration metadata and durable
  inbox/outbox state, `projects`/`workspaces` for host registries, `agent` through its barrel for
  session operations, `log` for closed-classifier diagnostics, and `matrix-js-sdk`.
- **Forbidden:** importing `host`, `web`, launchers, or another agent runtime; deriving host session
  state from Matrix room names/events; writing pi transcripts directly; accepting control authority
  from room membership, display names or room metadata; persisting passwords or access tokens outside
  the OS credential vault.

## Get right

The bot uses a dedicated account and exactly one explicitly configured full MXID may control ThinkRail.
Other room members may read mirrored room content but never issue commands. Homeservers and rooms are
assumed able to read plaintext; encrypted rooms are unsupported and fail closed. Only active/needs-input
sessions in open projects are automatically mapped; historical sessions require explicit mapping, and
every mapped session is reconciled from its complete host display transcript.

Messages received while the host is offline are not executed after restart; they are marked unprocessed
and the authorized controller is asked to resend. Any live input is deduplicated by homeserver, room ID
and Matrix event ID before dispatch. An uncertain host acceptance is never automatically replayed.
Outbox retries reuse the same Matrix transaction ID. Homeserver URLs are HTTPS-only and all SDK network
requests require bounded, redirect-safe Matrix API access.
