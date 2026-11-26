import type { IssueRepositories, IssueSummary } from "@thinkrail/contracts";
import { wsErrorCode } from "../transport";

export async function loadIssueRepositories(
	issues: readonly IssueSummary[],
	read: (issue: IssueSummary) => Promise<IssueRepositories>,
	isCurrent: () => boolean,
	publish: (issue: IssueSummary, value: IssueRepositories | "error" | "blocked") => void,
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (isCurrent() && next < issues.length) {
			const issue = issues[next++];
			if (!issue) return;
			let value: IssueRepositories | "error" | "blocked";
			try {
				value = await read(issue);
			} catch (error) {
				value = wsErrorCode(error) === "ISSUE_LAUNCH_BLOCKED" ? "blocked" : "error";
			}
			if (isCurrent()) publish(issue, value);
		}
	};
	await Promise.all(Array.from({ length: Math.min(8, issues.length) }, worker));
}
