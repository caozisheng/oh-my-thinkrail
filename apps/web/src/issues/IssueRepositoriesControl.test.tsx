import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { IssueRepositories, IssueSummary, Project } from "@thinkrail/contracts";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { selectRepoProjects } from "../store/selectors";
import {
	IssueRepositoriesControl,
	IssueRepositoriesPanel,
	type IssueRepositoriesView,
} from "./IssueRepositoriesControl";

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

function render(view: IssueRepositoriesView | undefined, disabled = false) {
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

function panel(view: IssueRepositories, join: boolean) {
	return renderToStaticMarkup(
		<IssueRepositoriesPanel
			candidates={projects.filter((project) => project.id !== primaryProjectId)}
			view={view}
			onToggle={() => {}}
			{...(join
				? {
						onJoin: async () => null,
						onCleanup: async () => ({ kind: "cleaned", count: 0 }) as const,
					}
				: {})}
		/>,
	);
}

test("a running implementation offers the other repositories to join and a cleanup", () => {
	const joinable = panel({ projectIds: [], locked: true }, true);
	expect(joinable).toContain("backend");
	expect(joinable).not.toContain('data-testid="issue-repositories-locked"');
	expect(joinable).not.toContain('data-testid="issue-repositories-cleanup"');
	const joined = panel({ projectIds: ["api-local"], locked: true }, true);
	expect(joined).toContain('data-joined="true"');
	expect(joined).toContain('data-testid="issue-repositories-cleanup"');
	// An older host keeps the fixed selection and its reason.
	const fixed = panel({ projectIds: ["api-local"], locked: true }, false);
	expect(fixed).toContain('data-testid="issue-repositories-locked"');
	expect(fixed).not.toContain("backend");
});

test("Issue repository choices use the repository selector and exclude the Chats container", () => {
	const projects: Project[] = [
		{ id: primaryProjectId, name: "frontend", path: "/frontend", slug: "frontend", lastOpened: 1 },
		{ id: "chats", name: "Chats", path: "/chats", slug: "chats", lastOpened: 1, kind: "chats" },
		{
			id: "api-local",
			name: "backend",
			path: "/backend",
			slug: "backend",
			lastOpened: 1,
		},
	];
	expect(selectRepoProjects({ projects }).map((project) => project.id)).toEqual([
		primaryProjectId,
		"api-local",
	]);
	const source = readFileSync(new URL("./IssuesTool.tsx", import.meta.url), "utf8");
	expect(source).toContain("useAppStore(useShallow(selectRepoProjects))");
	expect(source).toContain("repositoryProjects={projects}");
});

test("pending and failed refreshes keep the last confirmed linked indicator", () => {
	for (const flags of [{ pending: true }, { failed: true }]) {
		expect(render({ projectIds: ["api-local"], locked: false, ...flags })).toContain(
			'data-variant="soft-primary"',
		);
	}
});
