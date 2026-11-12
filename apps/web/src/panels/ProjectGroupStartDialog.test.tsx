import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Project } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
	defaultGroupPrimary,
	groupContextLines,
	ProjectGroupStartChoices,
} from "./ProjectGroupStartDialog";

function member(id: string, path: string): Project {
	return {
		id,
		name: id,
		path: path ? `/work/suite/${path}` : "/work/suite",
		slug: id,
		lastOpened: 1,
		projectGroup: { id: "g", name: "suite", root: "/work/suite", path },
	};
}

const noop = () => {};

function cards(canStart = true) {
	return renderToStaticMarkup(
		<ProjectGroupStartChoices
			canStart={canStart}
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

test("an Issue defaults to the first tracker-connected member, else nothing — the folder is never special", () => {
	const folder = member("folder", "");
	const billing = member("billing", "services/billing");
	const gateway = member("gateway", "services/gateway");
	const members = [folder, billing, gateway];
	expect(defaultGroupPrimary(members, new Set(["gateway"]))?.id).toBe("gateway");
	expect(defaultGroupPrimary(members, new Set(["gateway", "billing"]))?.id).toBe("billing");
	expect(defaultGroupPrimary(members, new Set())).toBeNull();
	expect(defaultGroupPrimary([], new Set(["gateway"]))).toBeNull();
});

test("the group start offers the three choices, none disabled for a plain (non-Git) group folder", () => {
	const markup = cards();
	const building = button(markup, "project-group-start-building");
	expect(building).toContain("Start building");
	expect(building).toContain("border-primary-muted bg-primary-subtle");
	expect(button(markup, "project-group-start-setup")).toContain("Set up project");
	expect(button(markup, "project-group-start-folder")).toContain("Work in project folder");
	expect(markup).not.toContain('disabled=""');
	expect(markup).not.toContain("not a Git repository");
});

test("the agent context names the plain group folder and every member by relative path", () => {
	expect(
		groupContextLines("/work/suite", [member("folder", ""), member("gw", "services/gateway")]),
	).toBe("/work/suite\n- . — /work/suite\n- services/gateway — /work/suite/services/gateway");
});

test("the start-building step reuses the Issues tool and the workbench's Issue session opener", () => {
	const source = readFileSync(new URL("./ProjectGroupStartDialog.tsx", import.meta.url), "utf8");
	expect(source).toContain("<IssuesTool");
	expect(source).toContain("openIssueSession(selected.id, launch, isCurrent)");
	expect(source).toContain('"issues.connection"');
	const tree = readFileSync(new URL("./ProjectTree.tsx", import.meta.url), "utf8");
	expect(tree).toContain('data-testid="project-group-start"');
	expect(tree).toContain("<ProjectGroupStartDialog");
});
