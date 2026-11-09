<p align="center">
  <img src="packages/shared/assets/icon.svg" alt="OMT — oh-my-thinkrail" width="160" height="160" />
</p>

# oh-my-thinkrail

A fork of [ThinkRail](https://github.com/JetBrains/thinkrail), adapted for the **Tomato workflow** and
issue-centered development collaboration.

The goal is to use **GitHub and GitLab Issues as durable records of key session decisions and
summaries**, so people and agents can resume work without depending on a single chat history or
machine. Issues capture goals, design decisions, progress, verification results, and handoffs—not full
chat transcripts or private reasoning.

This fork explores more efficient ways to collaborate across design, implementation, and review,
while retaining ThinkRail's [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)-based
sessions and isolated Git worktrees.

## Current scope

Issues integration is experimental and covers GitLab and GitHub repositories. The provider follows the
repository address — only `github.com` is GitHub, every other host is GitLab — and both use an access
token. It includes:

- HTTP(S) project association from the Issues panel or after opening or cloning a repository.
- Personal access tokens stored in the host's OS credential vault, with explicit consent for non-local
  HTTP connections and no plaintext storage fallback.
- An issue list with **Design** and **Implement** actions. Sessions use the Issue title; implementation
  creates or reuses an owned `.worktrees/issue-<IID>` workspace. The two activities can interleave.
- **Linked repositories**: an issue can name other open projects it also touches. Design reads their
  own checkouts; implementation then prepares a worktree in each of those repositories under its own
  `.worktrees/`, starts a single session only when every one is ready, and tags each worktree in the
  project rail with the issue number (`#23`, and `#23(master)` for the issue's primary worktree once
  it has linked repositories). Changes, review and commits stay attributed per repository; commits
  across repositories are not atomic, so a failure keeps the successful ones and is reported. Build
  and integration paths between the worktrees are the agent's normal reviewed work, not automatic.
- New Issue sessions load the built-in Tomato workflow skill and start once with the Issue body and
  complete comments, using the effective interface language. Reopening a session only opens its history.
  Session-bound tools read current Issue context and publish deliberate summaries without exposing tokens.
  The skill requires confirmed summary publication before handoff; automatic turn-end posting is not enforced.
  If publication is uncertain, reuse the original operation ID and exact summary with
  `issue_record_summary`'s `recovery: "reconcile"` to recover a unique matching published comment.
  Both recovery modes require explicit **human confirmation**; selecting the recovery enum represents
  that confirmation, never an agent inference. For `reconcile`, the human confirms adopting the exact-body
  receipt, which does not prove original authorship. `retry-confirmed-unpublished` requires human
  confirmation that the original request/process ended and remote publication did not happen, plus
  authorization to retry. Absence, errors and timeouts are not proof. Legacy intents can retry once
  with that confirmation, fresh zero exact matches and a durable exclusive retry fence; uncertainty
  after retry can only be reconciled, including after restart.

Starting implementation does not require design approval and does not change Issue labels. Approval
and Issue closure remain in the tracker. Automated push/MR/CI/merge delivery is not implemented.

Reads, listing, Issue sessions and summary publication work on both providers with identical issue and
label presentation. Approval receipts, design/implementation publication and merge stay GitLab-only for
now and are refused on GitHub; GitHub Enterprise Server and complete cross-machine handoffs remain
project goals. Existing upstream GitHub pull-request features are separate from Issues integration.

## GitHub and GitLab Issues

Both providers support listing Issues, reading their descriptions and comments, starting **Design**
and **Implement** sessions, reopening those sessions, and publishing session summaries as comments.
With host protocol v114 or newer, the existing eye-button preview shows the complete Issue:
its description followed by all ordinary comments, authors, timestamps and Markdown attachments.
The title remains an external link, and the preview keeps its original expand/collapse layout.
Incomplete reads report an error rather than silently truncating comments. Comment writing/editing
is not included. Hosts on v113 retain the description-only eye preview.

Issue cards, labels and Tomato stage grouping use the same presentation on both providers; GitHub pull
requests are excluded from the Issue list. On host protocol v113 or newer, the eye button previews
an Issue's Markdown body and images in place, including closed Issues. Only one body is expanded at a
time; refresh collapses it. The preview does not include comments; use the title link for the full
provider page. Private attachment images may require access through the provider website.

To connect, enter a **Repository address** and a personal access token in the Issues tool:

- `https://github.com/owner/repository.git` selects GitHub automatically. Classic and fine-grained PATs
  are accepted; the token needs access to the repository and Issues read/write permission to publish
  comments. GitHub Issues requires host protocol v110 or newer.
- GitLab addresses select GitLab, including self-hosted instances with a confirmed instance URL.
- Each local project has at most one Issue association: GitHub, GitLab, or none. Disconnect the current
  association before switching trackers in the UI.

The connection token remains in the host OS credential vault, never in agent prompts. GitHub Enterprise
Server and SSH/SCP repository addresses are not supported by this association flow. Approval and
publication workflow APIs remain GitLab-only as described above; ordinary Design/Implement startup does
not require those APIs on either provider.

## Inherited IDE capabilities

Workspaces use Git worktrees; managed checkout creation runs in the background with progress so large
repositories do not freeze the host. The shared IDE includes editor tabs, terminals, GitHub PR controls,
provider configuration, extension settings, and host-backed search across files, specs, plans and chats.
Local voice dictation can fill text fields without submitting them; recognition runs on the host with
an on-demand NVIDIA speech runtime and model download. Audio and transcripts are not sent to a cloud
speech service. Structured agent questions support rich previews,
per-option notes, and a Discuss action. These upstream capabilities remain separate from this fork's
Issue association and Tomato sessions.

## Windows Desktop releases

Run **Actions → Release Windows desktop → Run workflow** and select the branch to build (the
workflow must first be merged into the default branch to appear there). It builds only Windows x64
Desktop and publishes the installer to this repository's [Releases](https://github.com/caozisheng/oh-my-thinkrail/releases)
after expanded-app and installer smoke checks pass.

Versions use the latest official `JetBrains/thinkrail` Release plus the first eight characters of
this fork's build commit, for example `0.3.2.abcdef01`. The installer is
`oh-my-thinkrail-<version>-windows-x64.zip`; `SHA256SUMS` and `build-info.json` record its checksum,
full fork commit and upstream version provenance. The upstream version is a label, not a guarantee
that this fork contains every change in that upstream release. Existing tags/releases are never overwritten.

These are **unsigned, independent fork builds**, not JetBrains-signed distributions. Windows
SmartScreen may warn. Extract the complete ZIP and keep the setup EXE beside its payload when running
setup. Automatic desktop updates are disabled; install subsequent releases manually. Release builds
carry no upstream PostHog project key. Source-run privacy behavior is unchanged below.

## Development

Use the Bun version pinned in `package.json`, Node.js **22.23.4+**, and Git. The website build and
typecheck require Node.js 22.23.4+ for Astro 7.4; the in-process `pi` engine itself needs 22.19+.
Agent sessions also need a configured model provider.

```bash
git clone https://github.com/caozisheng/oh-my-thinkrail.git
cd oh-my-thinkrail
bun install
bun run dev
```

Fork application state defaults to **`~/.oh-my-thinkrail`**, separate from upstream's `~/.thinkrail`.
Existing upstream state is not automatically migrated. `THINKRAIL_DATA_DIR` overrides this location.
Pi configuration still defaults to `~/.pi/agent`; use `PI_CODING_AGENT_DIR` to isolate it as well.

Unsigned Windows preview builds are available from successful
[Preview artifacts workflow runs](https://github.com/caozisheng/oh-my-thinkrail/actions/workflows/build-preview.yml).
These are CI artifacts, not signed releases.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development details and
[architecture.md](architecture.md) for module boundaries and design decisions.

## Privacy

Issues are intended for deliberate summaries and handoffs, never credentials or full conversation
exports. Upstream telemetry behavior has not been removed: basic usage analytics and classifier-only
error reporting remain enabled; additional sharing is controlled in **Settings → Privacy**.

## Acknowledgments and license

Built on [ThinkRail](https://github.com/JetBrains/thinkrail) and the pi coding agent. This fork is an
independent project, not an official JetBrains distribution.

Licensed under the [Apache License 2.0](LICENSE).
