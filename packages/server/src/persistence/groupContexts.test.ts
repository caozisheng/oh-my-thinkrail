import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Workspace } from "@thinkrail/contracts";
import { loadProjects, loadWorkspaces, saveProjects, saveWorkspaces } from "./index";

const previous = process.env.THINKRAIL_DATA_DIR;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (previous === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previous;
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "group-store-"));
	roots.push(root);
	process.env.THINKRAIL_DATA_DIR = root;
	const repository: Project = { id: "repo", name: "Repo", slug: "repo", path: root, lastOpened: 1 };
	const owner: Project = { ...repository, id: "group", kind: "group" };
	const workspace: Workspace = {
		id: "group-home",
		projectId: owner.id,
		name: owner.name,
		kind: "group",
		worktreePath: root,
		branch: "",
		baseBranch: "",
	};
	return { root, repository, owner, workspace };
}

test("existing group documents round trip separately while each save preserves the other half", () => {
	const f = fixture();
	const groupFile = join(f.root, "group-contexts.json");
	writeFileSync(
		groupFile,
		JSON.stringify({ version: 1, projects: [f.owner], workspaces: [f.workspace] }),
	);
	expect(loadProjects()).toContainEqual(f.owner);
	expect(loadWorkspaces()).toContainEqual(f.workspace);
	saveProjects([f.repository, f.owner]);
	expect(JSON.parse(readFileSync(join(f.root, "projects.json"), "utf8"))).toEqual([f.repository]);
	expect(loadWorkspaces()).toContainEqual(f.workspace);
	saveWorkspaces([f.workspace]);
	expect(JSON.parse(readFileSync(join(f.root, "workspaces.json"), "utf8"))).toEqual([]);
	expect(loadProjects()).toContainEqual(f.owner);
	saveProjects([f.repository]);
	expect(JSON.parse(readFileSync(groupFile, "utf8"))).toEqual({
		version: 1,
		projects: [],
		workspaces: [f.workspace],
	});
	saveWorkspaces([]);
	expect(JSON.parse(readFileSync(groupFile, "utf8"))).toEqual({
		version: 1,
		projects: [],
		workspaces: [],
	});
});

test("invalid group state refuses facade writes before touching repository files", () => {
	const f = fixture();
	saveProjects([f.repository]);
	saveWorkspaces([]);
	for (const value of [
		"{",
		JSON.stringify({ version: 2, projects: [], workspaces: [] }),
		JSON.stringify({ version: 1, projects: [f.repository], workspaces: [] }),
	]) {
		writeFileSync(join(f.root, "group-contexts.json"), value);
		expect(() => saveProjects([])).toThrow();
		expect(() => saveWorkspaces([f.workspace])).toThrow();
		expect(JSON.parse(readFileSync(join(f.root, "projects.json"), "utf8"))).toEqual([f.repository]);
		expect(JSON.parse(readFileSync(join(f.root, "workspaces.json"), "utf8"))).toEqual([]);
		expect(readFileSync(join(f.root, "group-contexts.json"), "utf8")).toBe(value);
	}
});
