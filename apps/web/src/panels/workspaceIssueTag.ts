import type { WorkspaceIssueBinding } from "@thinkrail/contracts";

export function workspaceIssueTagText(issue: WorkspaceIssueBinding): string | null {
	if (!issue.hasAssociations) return null;
	return `#${issue.number}${issue.role === "primary" ? "(master)" : ""}`;
}
