---
id: submodule-desktop-fork-update
type: submodule-design
status: active
title: Fork release advisory
parent: module-desktop
tags: [desktop, updates]
---

## Responsibility

Watch the independent fork's GitHub Releases for a newer Windows desktop build and make it visible: the
check, the once-per-version native notification, and the release page the user installs from. The fork
publishes unsigned Windows x64 installers outside Electrobun's feed ([[module-ci-release]]), so the native
updater in [[submodule-desktop-updates]] stays disabled and cannot observe them.

## Boundary

- **Public surface (`index.ts`):** `createForkUpdateController` with its dependency and controller types,
  `fetchLatestForkRelease`, `forkUpdatesEnabled`, `createForkUpdateAdvisoryStore` /
  `FORK_UPDATE_ADVISORY_FILE`, and the pure `shouldNotify` rule.
- **Allowed deps:** the type-only `ForkUpdateBridge`/`ForkUpdateState` contract, the sibling
  `errorReporting` helper, Bun/Node, and injected clocks/randomness/fetch.
- **Forbidden:** web or server imports; the Electrobun updater, its feed, and its journal; downloading,
  checksumming, extracting or installing anything; host wire methods; renderer-supplied URLs.

Only a packaged stable Windows x64 build outside the desktop artifact-test seams checks at all; source,
browser, CLI, and development hosts never issue the request. The check is a single unauthenticated
`releases/latest` read with a five-second timeout after window readiness, then on a jittered six-hour
cadence. Every failure — network, rate limit, malformed body — is silent and leaves the surface idle, so the
Settings card's manual **Check again** is the only retry path.

## Version verdict

Fork tags are `vX.Y.Z.<fork sha8>` and the running build carries the same identity, so the comparison is
that triple plus the sha: a larger base is an update, a smaller base is ignored (never a downgrade), an equal
base with a different sha is an update (a re-published rebuild), and an equal base with the same sha is
current. A tag outside the strict pattern is no answer at all. Linux CLI Releases use `cli-v…` tags and are never marked latest
([[module-ci-release]]), so they never reach this check. The release page is composed locally from the
validated tag; the response's own URL is never used or trusted.

## Notification and memory

One native OS notification per discovered version, only while the window is unfocused — a focused window
already shows the Settings card and topbar chip, so a notification there would be noise. The announced
version lives in `<userData>/fork-update-advisory.json` and an unreadable file simply forgets, which can cost
at most one repeated notice. Notifications carry no click action ([[module-desktop]]: Electrobun click
callbacks are unlanded); the card and chip are the entry points.

**Deferred:** in-app download/verify/install and restart, re-enabling the Electrobun feed, a macOS/Linux fork
desktop build, notification click-through, and a user setting that disables the check.
