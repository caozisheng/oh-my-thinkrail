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

The server-only Matrix SDK boundary for constructing clients and verifying a bot access token against
a configured homeserver. This module does not yet own a live bridge, persist credentials, or project
ThinkRail state into Matrix rooms.

## Boundary

- **Owns:** SDK client creation and `/whoami` identity verification.
- **Public surface:** a server-only barrel. Credentials and SDK objects never cross the contracts wire.
- **Allowed deps:** `matrix-js-sdk` only.
- **Forbidden:** importing `host`, `web`, launchers, or another agent runtime; deriving host session
  state from Matrix room names/events; writing pi transcripts directly; accepting control authority
  from room membership, display names or room metadata; persisting passwords or access tokens outside
  the OS credential vault.

## Get right

Homeserver input is limited to an HTTPS origin without userinfo, path, query or fragment. Token
verification requires an exact configured MXID match and returns only the verified user/device identity;
the access token is never part of that result. SDK logging is disabled at this boundary so authorization
URLs and server responses cannot leak through its default logger.

matrix-js-sdk is licensed Apache-2.0 and declares Node.js >=22 support. Bun import, server typecheck,
CLI bundling and a mocked `/whoami` call have been exercised; a real homeserver sync and packaged CLI /
desktop runtime have not.
