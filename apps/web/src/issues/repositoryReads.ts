import type { IssueRepositories, IssueSummary } from "@thinkrail/contracts";
import { wsErrorCode } from "../transport";

export async function loadIssueRepositories(
	issues: readonly IssueSummary[],
	read: (issue: IssueSummary) => Promise<IssueRepositories>,
	isCurrent: () => boolean,
	publish: (issue: IssueSummary, value: IssueRepositories | "error" | "blocked") => void,
): Promise<void> {
	await Promise.all(
		issues.map(async (issue) => {
			let value: IssueRepositories | "error" | "blocked";
			try {
				value = await read(issue);
			} catch (error) {
				value = wsErrorCode(error) === "ISSUE_LAUNCH_BLOCKED" ? "blocked" : "error";
			}
			if (isCurrent()) publish(issue, value);
		}),
	);
}
