import { expect, test } from "bun:test";
import type { Project } from "@thinkrail/contracts";
import { groupMemberLabel, projectRailEntries } from "./projectGroups";

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

test("group members collapse under one entry at the first member's place, root then by path", () => {
	const entries = projectRailEntries([
		project("solo"),
		project("core", { id: "g", path: "libs/core" }),
		project("other"),
		project("root", { id: "g", path: "" }),
		project("app", { id: "g", path: "app" }),
		project("zeta", { id: "g", path: "zeta" }),
		project("nested", { id: "g", path: "a/nested" }),
	]);
	expect(
		entries.map((e) =>
			e.kind === "group" ? `group:${e.projects.map((p) => p.id).join(",")}` : e.project.id,
		),
	).toEqual(["solo", "group:root,nested,app,core,zeta", "other"]);
});

test("a group with a single open member stays a plain row", () => {
	expect(projectRailEntries([project("app", { id: "g", path: "app" })])).toStrictEqual([
		{ kind: "project", project: project("app", { id: "g", path: "app" }) },
	]);
});

const LAYOUT = [
	"",
	"infra",
	"infra/terraform",
	"services/auth",
	"services/billing",
	"services/billing/modules/invoice/core",
	"clients/desktop/linux",
	"clients/desktop/mac",
	"clients/mobile/ios",
	"deep/a/b/c4",
	"deep/a/b/c4/d5",
	"libs/internal/codec",
	"libs/vendor/zlib",
	"docs",
];

test("a group lists members flat: root first, then relative paths, no folder rows", () => {
	const projects = [...LAYOUT].reverse().map((path) => project(path || "root", { id: "g", path }));
	const [entry] = projectRailEntries(projects);
	expect(entry?.kind).toBe("group");
	if (entry?.kind !== "group") return;
	expect(entry.projects.map(groupMemberLabel)).toEqual([
		"root",
		"clients/desktop/linux",
		"clients/desktop/mac",
		"clients/mobile/ios",
		"deep/a/b/c4",
		"deep/a/b/c4/d5",
		"docs",
		"infra",
		"infra/terraform",
		"libs/internal/codec",
		"libs/vendor/zlib",
		"services/auth",
		"services/billing",
		"services/billing/modules/invoice/core",
	]);
});

test("a group without a root member is still a flat list sorted by path", () => {
	const projects = [project("b", { id: "g", path: "x/b" }), project("a", { id: "g", path: "x/a" })];
	const [entry] = projectRailEntries(projects);
	expect(entry?.kind === "group" ? entry.projects.map(groupMemberLabel) : []).toEqual([
		"x/a",
		"x/b",
	]);
});
