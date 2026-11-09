import { expect, test } from "bun:test";
import type { IssueRepositories, IssueSummary } from "@thinkrail/contracts";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
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
		<TooltipProvider>
			<IssueRepositoriesControl
				issue={issue}
				primaryProjectId={primaryProjectId}
				projects={projects}
				view={view}
				disabled={disabled}
				onOpen={() => {}}
				onToggle={() => {}}
			/>
		</TooltipProvider>,
	);
}

test("the trigger is an icon-only button, not a labelled row control", () => {
	const markup = render(undefined);
	expect(markup).toContain('data-testid="issue-repositories"');
	expect(markup).toContain('aria-haspopup="listbox"');
	expect(markup).not.toContain(">Linked repositories<");
});

test("the trigger shows the unlinked glyph with no selection and the linked one afterwards", () => {
	// `RiLinkUnlink` means "nothing linked yet"; `RiLink` and the soft-primary tone mark a live selection.
	expect(render(undefined)).toContain('data-variant="ghost"');
	expect(render({ projectIds: [], locked: false })).toContain('data-variant="ghost"');
	expect(render({ projectIds: ["api-local"], locked: false })).toContain(
		'data-variant="soft-primary"',
	);
});

test("the issue's own local project is never offered as a linked repository", () => {
	const views: (IssueRepositories | undefined)[] = [
		undefined,
		{ projectIds: ["api-local"], locked: false },
	];
	for (const view of views) expect(render(view)).not.toContain("frontend");
});

test("a locked selection renders its reason instead of a stale candidate list", () => {
	const markup = render({ projectIds: ["api-local"], locked: true });
	expect(markup).toContain('data-locked="true"');
	expect(markup).not.toContain("backend");
});
