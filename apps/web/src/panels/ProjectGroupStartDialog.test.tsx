import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Project } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
	defaultGroupPrimary,
	groupRootMember,
	ProjectGroupStartChoices,
} from "./ProjectGroupStartDialog";

function member(id: string, path: string): Project {
	return {
		id,
		name: id,
		path: `/work/${path || "suite"}`,
		slug: id,
		lastOpened: 1,
		projectGroup: { id: "g", name: "suite", root: "/work/suite", path },
	};
}

const noop = () => {};

function cards(rootProjectId: string | null) {
	return renderToStaticMarkup(
		<ProjectGroupStartChoices
			canStartIssue
			rootProjectId={rootProjectId}
			onStartBuilding={noop}
			onSetup={noop}
			onProjectFolder={noop}
		/>,
	);
}

function button(markup: string, testId: string): string {
	const at = markup.indexOf(`data-testid="${testId}"`);
	expect(at).toBeGreaterThan(-1);
	const start = markup.lastIndexOf("<button", at);
	return markup.slice(start, markup.indexOf("</button>", at));
}

test("an Issue starts in the root repository by default, else the shallowest member", () => {
	const root = member("root", "");
	const core = member("core", "libs/core");
	expect(groupRootMember([root, core])?.id).toBe("root");
	expect(defaultGroupPrimary([root, core])?.id).toBe("root");
	expect(groupRootMember([core])).toBeNull();
	expect(defaultGroupPrimary([core, member("ui", "apps/ui")])?.id).toBe("core");
	expect(defaultGroupPrimary([])).toBeNull();
});

test("the group start offers the three project start choices with Start building highlighted", () => {
	const markup = cards("root");
	const building = button(markup, "project-group-start-building");
	expect(building).toContain("Start building");
	expect(building).toContain("border-primary-muted bg-primary-subtle");
	expect(button(markup, "project-group-start-setup")).toContain("Set up project");
	expect(button(markup, "project-group-start-folder")).toContain("Work in project folder");
	expect(markup).not.toContain('disabled=""');
});

test("a group folder that is not a repository keeps both root choices visible but disabled with the reason", () => {
	const markup = cards(null);
	expect(button(markup, "project-group-start-building")).not.toContain('disabled=""');
	for (const id of ["project-group-start-setup", "project-group-start-folder"]) {
		const card = button(markup, id);
		expect(card).toContain('disabled=""');
		expect(card).toContain("the group folder is not a Git repository");
	}
});

test("the start-building step reuses the Issues tool and the workbench's Issue session opener", () => {
	const source = readFileSync(new URL("./ProjectGroupStartDialog.tsx", import.meta.url), "utf8");
	expect(source).toContain("<IssuesTool");
	expect(source).toContain("openIssueSession(primary.id, launch, isCurrent)");
	const tree = readFileSync(new URL("./ProjectTree.tsx", import.meta.url), "utf8");
	expect(tree).toContain('data-testid="project-group-start"');
	expect(tree).toContain("<ProjectGroupStartDialog");
});
