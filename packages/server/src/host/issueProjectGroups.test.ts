import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@thinkrail/contracts";
import { groupRepositoryDefaults, groupWorkspaceLayout } from "./issuesActions";

let dataDir: string;
let suite: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function member(id: string, path: string, extra: Partial<Project> = {}): Project {
	const folder = path ? join(suite, ...path.split("/")) : suite;
	mkdirSync(folder, { recursive: true });
	return {
		id,
		name: id,
		path: folder,
		slug: id,
		lastOpened: 1,
		trusted: true,
		projectGroup: { id: "g1", name: "suite", root: suite, path },
		...extra,
	};
}

function seed(projects: Project[]): void {
	writeFileSync(join(dataDir, "projects.json"), JSON.stringify(projects));
}

beforeEach(() => {
	dataDir = realpathSync.native(mkdtempSync(join(tmpdir(), "trpi-issue-groups-")));
	suite = join(dataDir, "suite");
	mkdirSync(suite);
	process.env.THINKRAIL_DATA_DIR = dataDir;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("an Issue's default selection is the open, trusted other members of its group", () => {
	seed([
		member("app", "app"),
		member("core", "libs/core"),
		member("closed", "closed", { closed: true }),
		member("untrusted", "untrusted", { trusted: false }),
		member("root", ""),
		{
			id: "loose",
			name: "loose",
			path: join(dataDir, "loose"),
			slug: "loose",
			lastOpened: 1,
			trusted: true,
		},
	]);
	expect(groupRepositoryDefaults("core")).toEqual(["root", "app"]);
	expect(groupRepositoryDefaults("loose")).toEqual([]);
});

test("a layout needs every participant in the group, at its place, with the root repository", () => {
	seed([member("root", ""), member("app", "app"), member("core", "libs/core")]);
	expect(groupWorkspaceLayout("app", ["app", "root", "core"])).toEqual({
		root: suite,
		paths: [
			{ projectId: "app", path: "app" },
			{ projectId: "root", path: "" },
			{ projectId: "core", path: "libs/core" },
		],
	});
	expect(groupWorkspaceLayout("app", ["app", "core"])).toBeNull();
	seed([
		member("app", "app"),
		member("core", "libs/core"),
		{
			...member("moved", "moved"),
			projectGroup: { id: "g1", name: "suite", root: suite, path: "elsewhere" },
		},
		{
			...member("other", "other"),
			projectGroup: { id: "g2", name: "x", root: suite, path: "other" },
		},
	]);
	expect(groupWorkspaceLayout("app", ["app", "core"])?.paths.map((p) => p.path)).toEqual([
		"app",
		"libs/core",
	]);
	expect(groupWorkspaceLayout("app", ["app", "moved"])).toBeNull();
	expect(groupWorkspaceLayout("app", ["app", "other"])).toBeNull();
});
