# Verify delivery completeness

Entry: implementation is ready for a per-repository delivery card. Return to **Stage confirmation
and delivery** in `SKILL.md` after checking necessary changes; the workspace need not be clean.
This path never recovers an uncertain remote mutation.

1. Identify the exact selected repository, worktree, HEAD and branch. Inspect staged, unstaged and
   untracked changes with `git status --short --untracked-files=all` and scoped diffs. Never print
   private `.env` contents. Classify remaining files using task context, not a filename whitelist.
2. Verify and commit necessary task changes within existing commit authority using explicit paths or
   selected hunks. For lockfiles, check dependency manifests, pinned tooling and reproducibility;
   neither assume a lockfile is unrelated nor include it blindly. If HEAD changes, the delivery card
   must show the actual new commit. Do not claim the earlier SHA is still the delivery version.
3. If necessity is uncertain, use `ask_user_question` with sanitized filenames and implications:
   include the change after review/verification, keep it local and exclude it from this delivery,
   or continue investigating. Do not silently exclude doubtful implementation files or merely report
   an indefinite dirty-checkout blocker. A skipped answer is not permission to guess file necessity;
   retain the file and explain which concrete decision remains open before delivering dependent work.
4. Keep unrelated tracked edits, private `.env`, credentials and Python caches intact and out of
   commits. No cleanup, automatic stash, restore, deletion or ignore change is required for delivery.
   Do not change shared ignore rules just to hide status. If preservation or relocation is requested,
   verify a recoverable backup first and obtain approval for destructive or ambiguous changes.
5. Confirm all necessary changes are committed and remaining files are deliberately local. Report
   sanitized exclusions without exposing secrets. Tests using local configuration may support joint
   manual testing; tests depending on uncommitted code do not establish the same result for the
   committed version. Run affected checks against the delivery commit or state the validation limit.
6. Prepare the delivery card for that committed SHA. Remaining staged, unstaged and untracked files
   are excluded from push and must not permanently block a card. If an older host still refuses
   `checkout-dirty`, report an upgrade requirement and preserve files; do not weaken it via shell.
   After a known pre-mutation prepare refusal, reuse the original operationId and exact input when
   retrying. Immutable journal rejection still blocks replacement IDs; an execute failure, timeout
   or uncertain intent requires the separate uncertainty rules, never automatic replay.

Return to **Stage confirmation and delivery** for the exact host card and real human submission.
If required file decisions remain unresolved, retain the files, provide the actionable question and
return for the required partial/blocked Issue handoff; never bypass authorization.
