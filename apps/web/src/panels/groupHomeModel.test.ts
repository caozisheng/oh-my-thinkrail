import { expect, test } from "bun:test";
import type { ProjectGroupIssue, ProjectGroupRepositoryStatus } from "@thinkrail/contracts";
import {
	issueKey,
	issueTotals,
	MAIN_BEHIND_WARNING,
	mainCheckoutWarnings,
	repositoryState,
} from "./groupHomeModel";

const issue: ProjectGroupIssue = {
	provider: "gitlab",
	instanceUrl: "https://gitlab.example",
	number: 7,
	projectId: "gateway",
	repositories: [
		{
			projectId: "gateway",
			role: "primary",
			workspaceId: "w1",
			ahead: 0,
			changedFiles: 0,
			changed: false,
		},
		{
			projectId: "billing",
			role: "associated",
			workspaceId: "w2",
			ahead: 2,
			changedFiles: 3,
			changed: true,
		},
		{
			projectId: "core",
			role: "associated",
			workspaceId: "w3",
			ahead: 1,
			changedFiles: 0,
			changed: true,
		},
		{ projectId: "auth", role: "associated" },
	],
};

test("an Issue row totals its repositories, changed ones, commits ahead and dirty worktrees", () => {
	expect(issueTotals(issue)).toEqual({
		repositories: 4,
		changed: 2,
		ahead: 3,
		dirty: 1,
		measured: true,
	});
	expect(
		issueTotals({ ...issue, repositories: [{ projectId: "gateway", role: "primary" }] }),
	).toEqual({ repositories: 1, changed: 0, ahead: 0, dirty: 0, measured: false });
	expect(issue.repositories.map(repositoryState)).toEqual([
		"unchanged",
		"changed",
		"changed",
		"unknown",
	]);
	expect(issueKey("g1", issue)).toBe("g1|https://gitlab.example#7:gateway");
});

test("main checkouts only warn when dirty or far behind their upstream", () => {
	const rows: ProjectGroupRepositoryStatus[] = [
		{ projectId: "root", path: "", branch: "main", dirty: false },
		{ projectId: "app", path: "app", branch: "main", dirty: true },
		{ projectId: "web", path: "web", branch: "main", dirty: null },
		{
			projectId: "near",
			path: "near",
			branch: "main",
			dirty: false,
			upstream: "origin/main",
			ahead: 0,
			behind: MAIN_BEHIND_WARNING - 1,
		},
		{
			projectId: "far",
			path: "far",
			branch: "main",
			dirty: false,
			upstream: "origin/main",
			ahead: 0,
			behind: MAIN_BEHIND_WARNING,
		},
	];
	const warnings = mainCheckoutWarnings(rows);
	expect(warnings.dirty.map((row) => row.projectId)).toEqual(["app"]);
	expect(warnings.behind.map((row) => row.projectId)).toEqual(["far"]);
	expect(mainCheckoutWarnings([rows[0] as ProjectGroupRepositoryStatus])).toEqual({
		dirty: [],
		behind: [],
	});
});
