import type { IssueRepositories, IssueSummary } from "@thinkrail/contracts";

export async function loadIssueRepositories(
	issues: readonly IssueSummary[],
	read: (issue: IssueSummary) => Promise<IssueRepositories>,
	isCurrent: () => boolean,
	publish: (issue: IssueSummary, value: IssueRepositories | "error") => void,
): Promise<void> {
	await Promise.all(
		issues.map(async (issue) => {
			let value: IssueRepositories | "error";
			try {
				value = await read(issue);
			} catch {
				value = "error";
			}
			if (isCurrent()) publish(issue, value);
		}),
	);
}
