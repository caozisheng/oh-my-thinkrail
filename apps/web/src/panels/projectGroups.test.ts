import { expect, test } from "bun:test";
import type { Project } from "@thinkrail/contracts";
import {
	folderNodeKey,
	type ProjectGroupTreeNode,
	projectGroupTree,
	projectRailEntries,
	treeProjects,
} from "./projectGroups";

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
	expect(projectRailEntries([project("app", { id: "g", path: "app" })])).toStrictEqual([
		{ kind: "project", project: project("app", { id: "g", path: "app" }) },
	]);
});

function outline(nodes: readonly ProjectGroupTreeNode[], indent = ""): string[] {
	return nodes.flatMap((node) => [
		`${indent}${node.kind === "folder" ? "[" : ""}${node.label}${node.kind === "folder" ? "]" : ""}`,
		...outline(node.children, `${indent}  `),
	]);
}

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

test("the group tree mirrors the folder layout with folder rows and folded single-child chains", () => {
	const projects = [...LAYOUT].reverse().map((path) => project(path || "root", { id: "g", path }));
	expect(outline(projectGroupTree("g", projects))).toEqual([
		"root",
		"[clients]",
		"  [desktop]",
		"    linux",
		"    mac",
		"  [mobile]",
		"    ios",
		"[deep/a/b]",
		"  c4",
		"    d5",
		"docs",
		"infra",
		"  terraform",
		"[libs]",
		"  [internal]",
		"    codec",
		"  [vendor]",
		"    zlib",
		"[services]",
		"  auth",
		"  billing",
		"    [modules/invoice]",
		"      core",
	]);
});

test("tree rows carry full relative paths, member ids and per-group folder keys", () => {
	const projects = LAYOUT.map((path) => project(path || "root", { id: "g", path }));
	const tree = projectGroupTree("g", projects);
	const services = tree.find((node) => node.label === "services");
	expect(services).toMatchObject({
		kind: "folder",
		path: "services",
		key: folderNodeKey("g", "services"),
	});
	const billing = services?.children[1];
	expect(billing).toMatchObject({
		kind: "repository",
		key: "services/billing",
		path: "services/billing",
	});
	expect(billing?.children[0]).toMatchObject({
		kind: "folder",
		label: "modules/invoice",
		path: "services/billing/modules/invoice",
	});
	expect(tree.find((node) => node.label === "deep/a/b")?.path).toBe("deep/a/b");
	expect(treeProjects(tree).map((p) => p.projectGroup?.path)).toHaveLength(LAYOUT.length);
	expect(treeProjects(tree)[0]?.id).toBe("root");
});

test("a group without a root member starts at its top folders, and the rail entry carries the tree", () => {
	const projects = [project("a", { id: "g", path: "x/a" }), project("b", { id: "g", path: "x/b" })];
	expect(outline(projectGroupTree("g", projects))).toEqual(["[x]", "  a", "  b"]);
	const [entry] = projectRailEntries(projects);
	expect(entry?.kind === "group" ? outline(entry.tree) : []).toEqual(["[x]", "  a", "  b"]);
});
