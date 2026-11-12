# Prepare a clean delivery checkout

Entry: the selected delivery checkout is dirty, or prepare returned `checkout-dirty` before a card.
Save only necessary recovery artifacts; return to **Stage confirmation and delivery** in `SKILL.md`
when the checkout is clean. This path never recovers an uncertain remote mutation.

1. Identify the exact selected repository, worktree, HEAD and branch. Inspect `git status --short
   --untracked-files=all`, staged/unstaged diffs and applicable local instructions. Do not assume that
   a dirty associated repository means every repository is dirty. Never print private `.env` contents.
2. Review lockfile changes against dependency manifests and the intended implementation. Verify that
   necessary changes are reproducible with the repository's pinned tooling and relevant checks;
   do not install blindly in a worktree containing changes to preserve. Commit only verified,
   task-related changes within existing commit authority, using explicit paths or selected hunks.
   A lockfile is neither automatically unrelated nor automatically safe to include. If committing
   changes HEAD, the next delivery card must show that actual commit; never claim the prior SHA.
3. Preserve unrelated tracked edits before restoring anything. Use a verified, recoverable patch or
   backup outside the tracked tree; preserve staged and unstaged edits separately where needed.
   Record recovery location/instructions locally without publishing private content. Restore only
   reviewed paths/hunks after confirming the backup is complete. Ask before destructive or ambiguous
   changes; never use blanket reset, clean, checkout or automatic stash to make the gate green.
4. Keep `.env`, credentials and Python caches out of commits. Preserve local private files in place;
   use the worktree's effective local Git exclude file (`git rev-parse --git-path info/exclude`) for
   appropriate private/cache paths without adding a shared `.gitignore` change solely for delivery.
   Check scope in linked worktrees before editing excludes. Ignoring must not hide implementation
   files that belong in the commit, and does not untrack an already tracked secret. Never delete,
   upload or include private files in a general patch; handle already tracked private data separately.
5. Verify private files/backups still exist, required local test configuration remains available, and
   `git status --porcelain` is empty for each repository about to be confirmed. Rerun checks affected
   by the final committed tree; tests against unrelated local edits do not prove the committed tree.
6. Only after an explicit pre-mutation `checkout-dirty` refusal, re-prepare with the ORIGINAL operationId
   and exact title/body/target input. Let the host validate the new snapshot; do not edit journals or
   invent another ID if the immutable operation is rejected. Show the returned card unchanged and wait
   for its real answer. An execute failure, timeout or uncertain intent is not this case: stop and
   report it under `SKILL.md`'s existing uncertainty rules, with no automatic replay.

If preservation or cleanup cannot be completed safely, retain the files and report the selected
repository and sanitized blocker. Return to **Stage confirmation and delivery** only after clean-state
verification; otherwise return for the required blocked Issue handoff.
