import { expect, test } from "bun:test";
import type { IssueRepositories, IssueSummary } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueRepositoriesControl } from "./IssueRepositoriesControl";

/** `reference.projectId` is the remote id; the local primary project is identified separately. */
const issue: IssueSummary = {
	reference: {
		provider: "github",
		instanceUrl: "https://github.com",
		projectId: "1445121972",
		number: 23,
	},
	title: "Support git repo",
	url: "https://github.com/caozisheng/oh-my-thinkrail/issues/23",
	labels: [],
	stage: "backlog",
	updatedAt: "2026-11-09T00:00:00Z",
};
const primaryProjectId = "92f94e8f-70bf-481c-a2ea-5b570e51e403";
const projects = [
	{ id: primaryProjectId, name: "frontend" },
	{ id: "api-local", name: "backend" },
];

function render(view: IssueRepositories | "loading" | "error" | undefined, disabled = false) {
	return renderToStaticMarkup(
		<IssueRepositoriesControl
			issue={issue}
			primaryProjectId={primaryProjectId}
			projects={projects}
			view={view}
			disabled={disabled}
			onOpen={() => {}}
			onToggle={() => {}}
		/>,
	);
}

test("an unopened control states the empty default without claiming a selection", () => {
	const markup = render(undefined);
	expect(markup).toContain('data-testid="issue-repositories"');
	expect(markup).toContain("Linked repositories");
});

test("the issue's own local project is never offered as a linked repository", () => {
	const views: (IssueRepositories | undefined)[] = [
		undefined,
		{ projectIds: ["api-local"], locked: false },
	];
	for (const view of views) expect(render(view)).not.toContain("frontend");
});

test("a saved selection reports its count and never renders a stale list of projects", () => {
	const markup = render({ projectIds: ["api-local"], locked: true });
	expect(markup).toContain("1 linked");
	expect(markup).not.toContain("backend");
});
