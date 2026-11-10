import { expect, test } from "bun:test";
import type { Project } from "@thinkrail/contracts";
import { projectRailEntries } from "./projectGroups";

function project(id: string, group?: { id: string; path: string }): Project {
	return {
		id,
		name: id,
		path: `/work/${id}`,
		slug: id,
		lastOpened: 1,
		...(group
			? {
					projectGroup: {
						id: group.id,
						name: `group ${group.id}`,
						root: "/work",
						path: group.path,
					},
				}
			: {}),
	};
}

test("group members collapse under one entry at the first member's place, shallow-first", () => {
	const entries = projectRailEntries([
		project("solo"),
		project("core", { id: "g", path: "libs/core" }),
		project("other"),
		project("root", { id: "g", path: "" }),
		project("app", { id: "g", path: "app" }),
	]);
	expect(
		entries.map((e) =>
			e.kind === "group" ? `group:${e.projects.map((p) => p.id).join(",")}` : e.project.id,
		),
	).toEqual(["solo", "group:root,app,core", "other"]);
});

test("a group with a single open member stays a plain row", () => {
	expect(projectRailEntries([project("app", { id: "g", path: "app" })])).toEqual([
		{ kind: "project", project: project("app", { id: "g", path: "app" }) },
	]);
});
