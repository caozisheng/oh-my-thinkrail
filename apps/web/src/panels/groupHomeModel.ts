import type {
	ProjectGroupIssue,
	ProjectGroupIssueRepository,
	ProjectGroupRepositoryStatus,
} from "@thinkrail/contracts";
import { STORAGE_PREFIX } from "../constants/branding";
import { getTransport } from "../transport";

/** A main checkout this many commits behind its upstream (as of the last fetch) is worth a mention. */
export const MAIN_BEHIND_WARNING = 10;

export interface IssueTotals {
	/** Repositories in the Issue's workspace: the primary plus every joined member. */
	repositories: number;
	/** Repositories with commits beyond their start or uncommitted files. */
	changed: number;
	/** Commits beyond the start, summed over the repositories that could be measured. */
	ahead: number;
	/** Repositories with uncommitted files in their Issue worktree. */
	dirty: number;
	/** False until the host measured at least one repository (an older host or no worktree yet). */
	measured: boolean;
}

export function issueTotals(issue: ProjectGroupIssue): IssueTotals {
	let changed = 0;
	let ahead = 0;
	let dirty = 0;
	let measured = false;
	for (const repository of issue.repositories) {
		if (repository.changed) changed++;
		if (repository.ahead !== undefined) {
			ahead += repository.ahead;
			measured = true;
		}
		if ((repository.changedFiles ?? 0) > 0) dirty++;
	}
	return { repositories: issue.repositories.length, changed, ahead, dirty, measured };
}

/** `unchanged` only when the host proved no commits since the start and a clean worktree. */
export function repositoryState(
	repository: ProjectGroupIssueRepository,
): "changed" | "unchanged" | "unknown" {
	if (repository.changed === true) return "changed";
	if (repository.changed === false) return "unchanged";
	return "unknown";
}

export interface MainCheckoutWarnings {
	dirty: ProjectGroupRepositoryStatus[];
	behind: ProjectGroupRepositoryStatus[];
}

/** Main checkouts (Default workspaces) that need a word: uncommitted changes or far behind upstream. */
export function mainCheckoutWarnings(
	repositories: readonly ProjectGroupRepositoryStatus[],
): MainCheckoutWarnings {
	return {
		dirty: repositories.filter((row) => row.dirty === true),
		behind: repositories.filter((row) => (row.behind ?? 0) >= MAIN_BEHIND_WARNING),
	};
}

export function issueKey(groupId: string, issue: ProjectGroupIssue): string {
	return `${groupId}|${issue.instanceUrl}#${issue.number}:${issue.projectId}`;
}

const EXPANDED_ISSUES = "group-home-expanded-issues";

function storageKey(): string {
	return `${STORAGE_PREFIX}${EXPANDED_ISSUES}:${getTransport().httpBase()}`;
}

/** Group home Issue rows the user expanded; every row starts collapsed. */
export function readExpandedIssues(): Set<string> {
	try {
		const raw = localStorage.getItem(storageKey());
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return new Set(
			Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [],
		);
	} catch {
		return new Set();
	}
}

export function persistExpandedIssues(keys: ReadonlySet<string>): void {
	try {
		localStorage.setItem(storageKey(), JSON.stringify([...keys]));
	} catch {}
}
