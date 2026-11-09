import type { WorkspaceIssueBinding } from "@thinkrail/contracts";

/** The visible tag text: `#23`, and `#23(master)` for the primary of an issue with associates. */
export function workspaceIssueTagText(issue: WorkspaceIssueBinding): string {
	const linked = issue.role === "primary" && issue.hasAssociations;
	return `#${issue.number}${linked ? "(master)" : ""}`;
}
