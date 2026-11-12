import { expect, test } from "bun:test";
import type { IssueSummary } from "@thinkrail/contracts";
import { RequestError } from "../transport";
import { loadIssueRepositories } from "./repositoryReads";

const issues = [1, 2].map((number) => ({
	reference: { provider: "github", instanceUrl: "https://github.com", projectId: "7", number },
})) as IssueSummary[];

test("loads saved selections independently for every listed issue", async () => {
	const results: unknown[] = [];
	await loadIssueRepositories(
		issues,
		async (issue) => {
			if (issue.reference.number === 2) throw new Error("fixture");
			return { projectIds: ["api"], locked: true };
		},
		() => true,
		(issue, value) => results.push([issue.reference.number, value]),
	);
	expect(results).toEqual([
		[1, { projectIds: ["api"], locked: true }],
		[2, "error"],
	]);
});

test("only explicit lock contention is classified as locked", async () => {
	for (const [error, expected] of [
		[new RequestError("ISSUE_LAUNCH_BLOCKED", "private"), "blocked"],
		[new RequestError("RESOURCE_UNAVAILABLE", "locked"), "error"],
		[new Error("locked"), "error"],
	] as const) {
		const results: unknown[] = [];
		await loadIssueRepositories(
			issues.slice(0, 1),
			async () => {
				throw error;
			},
			() => true,
			(_issue, value) => results.push(value),
		);
		expect(results).toEqual([expected]);
	}
});

test("drops replies after the owning refresh becomes stale", async () => {
	let current = true;
	const results: unknown[] = [];
	await loadIssueRepositories(
		issues,
		async () => {
			current = false;
			return { projectIds: ["api"], locked: false };
		},
		() => current,
		(_issue, value) => results.push(value),
	);
	expect(results).toEqual([]);
});
