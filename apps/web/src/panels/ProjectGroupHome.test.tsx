import { expect, test } from "bun:test";
import type { Project, ProjectGroupIssue } from "@thinkrail/contracts";
import { EN } from "@thinkrail/locales";
import { renderToStaticMarkup } from "react-dom/server";
import { issueKey } from "./groupHomeModel";
import { GroupIssueList, MainCheckoutNotice } from "./ProjectGroupHome";

function project(id: string, path: string): Project {
	return {
		id,
		name: path.split("/").at(-1) || "suite",
		path: `/suite/${path}`,
		slug: id,
		lastOpened: 1,
		projectGroup: { id: "g1", name: "suite", root: "/suite", path },
	};
}
const projectById = new Map(
	[
		project("root", ""),
		project("gateway", "services/gateway"),
		project("billing", "services/billing"),
		project("auth", "services/auth"),
	].map((p) => [p.id, p]),
);
const issue: ProjectGroupIssue = {
	provider: "gitlab",
	instanceUrl: "https://gitlab.example",
	number: 7,
	title: "Split invoices",
	projectId: "gateway",
	repositories: [
		{
			projectId: "gateway",
			role: "primary",
			workspaceId: "w1",
			path: "services/gateway",
			branch: "issue-7-a",
			baseSource: "created",
			ahead: 0,
			behind: 0,
			changedFiles: 0,
			changed: false,
		},
		{
			projectId: "billing",
			role: "associated",
			workspaceId: "w2",
			path: "services/billing",
			branch: "issue-7-b",
			baseSource: "recorded",
			ahead: 2,
			behind: 1,
			defaultBranch: "origin/main",
			changedFiles: 3,
			changed: true,
		},
	],
};
const noop = () => {};

test("an Issue row is collapsed by default and summarizes what it changed", () => {
	const html = renderToStaticMarkup(
		<GroupIssueList
			groupId="g1"
			issues={[issue]}
			projectById={projectById}
			expanded={new Set()}
			onToggle={noop}
			onOpen={noop}
		/>,
	);
	expect(html).toContain('aria-expanded="false"');
	expect(html).toContain("Split invoices");
	expect(html).toContain("2 repositories · 1 changed");
	expect(html).toContain('data-testid="group-home-issue-ahead"');
	expect(html).toContain('data-testid="group-home-issue-dirty"');
	expect(html).not.toContain('data-testid="group-home-issue-repository"');
});

test("an expanded Issue lists each repository's branch, commits ahead, behind and uncommitted files", () => {
	const html = renderToStaticMarkup(
		<GroupIssueList
			groupId="g1"
			issues={[issue]}
			projectById={projectById}
			expanded={new Set([issueKey("g1", issue)])}
			onToggle={noop}
			onOpen={noop}
		/>,
	);
	expect(html).toContain('aria-expanded="true"');
	expect(html).toContain('data-project="gateway" data-state="unchanged"');
	expect(html).toContain('data-project="billing" data-state="changed"');
	expect(html).toContain("issue-7-b");
	expect(html).toContain('data-testid="group-home-repository-behind"');
	expect(html).toContain("3 uncommitted files");
	expect(html).toContain(String(EN["panels.groupHome.unchanged"]));
	expect(html).toContain(String(EN["panels.groupHome.primaryBadge"]));
});

test("the main-checkout notice appears only when a main directory needs attention", () => {
	expect(
		renderToStaticMarkup(
			<MainCheckoutNotice
				repositories={[{ projectId: "root", path: "", branch: "main", dirty: false }]}
				projectById={projectById}
			/>,
		),
	).toBe("");
	const html = renderToStaticMarkup(
		<MainCheckoutNotice
			repositories={[
				{ projectId: "root", path: "", branch: "main", dirty: true },
				{ projectId: "auth", path: "services/auth", branch: "main", dirty: true },
			]}
			projectById={projectById}
		/>,
	);
	expect(html).toContain("main directories have uncommitted changes: ., services/auth");
});
