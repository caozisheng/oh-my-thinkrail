import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@thinkrail/contracts";
import {
	importProjectGroup,
	projectGroupMembers,
	projectGroupProjects,
	removeProjectGroup,
	scanProjectGroup,
} from "./groups";
import { closeProject, getProjects, setProjectPublisher } from "./projects";

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!result.success) throw new Error(`git ${args.join(" ")} failed`);
}

function makeRepo(path: string): void {
	mkdirSync(path, { recursive: true });
	git(path, "init", "-b", "main");
	git(
		path,
		"-c",
		"user.email=t@thinkrail.test",
		"-c",
		"user.name=test",
		"commit",
		"--allow-empty",
		"-m",
		"init",
	);
}

let dataDir: string;
let work: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

beforeEach(() => {
	dataDir = realpathSync.native(mkdtempSync(join(tmpdir(), "trpi-group-data-")));
	work = realpathSync.native(mkdtempSync(join(tmpdir(), "trpi-group-work-")));
	process.env.THINKRAIL_DATA_DIR = dataDir;
});

afterEach(() => {
	setProjectPublisher(null);
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("scan finds nested repositories shallow-first and includes a repository root", async () => {
	const root = join(work, "suite");
	makeRepo(root);
	makeRepo(join(root, "app"));
	makeRepo(join(root, "libs", "core"));
	makeRepo(join(root, "app", "plugins", "x"));
	const scan = await scanProjectGroup(root);
	expect(scan.root).toBe(root);
	expect(scan.name).toBe("suite");
	expect(scan.truncated).toBe(false);
	expect(scan.repositories).toEqual([
		{ path: "", name: "suite" },
		{ path: "app", name: "app" },
		{ path: "libs/core", name: "core" },
		{ path: "app/plugins/x", name: "x" },
	]);
});

test("scan of a plain folder lists only the nested repositories", async () => {
	makeRepo(join(work, "a"));
	makeRepo(join(work, "b"));
	expect((await scanProjectGroup(work)).repositories.map((r) => r.path)).toEqual(["a", "b"]);
});

test("scan stops at the depth limit and skips dependency, hidden and linked folders", async () => {
	makeRepo(join(work, "one", "two", "three", "four", "five", "six"));
	makeRepo(join(work, "one", "two", "three", "four", "five", "six", "seven"));
	makeRepo(join(work, "libs", "vendor", "zlib"));
	makeRepo(join(work, "node_modules", "dep"));
	makeRepo(join(work, "build", "out"));
	makeRepo(join(work, ".worktrees", "issue-1"));
	makeRepo(join(work, ".hidden", "repo"));
	const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "trpi-group-outside-")));
	try {
		makeRepo(join(outside, "linked"));
		symlinkSync(join(outside, "linked"), join(work, "linked"), "dir");
		symlinkSync(outside, join(work, "parent-link"), "dir");
		const scan = await scanProjectGroup(work, { maxDepth: 6 });
		expect(scan.repositories.map((r) => r.path)).toEqual([
			"libs/vendor/zlib",
			"one/two/three/four/five/six",
		]);
		expect((await scanProjectGroup(work, { maxDepth: 7 })).repositories.map((r) => r.path)).toEqual(
			["libs/vendor/zlib", "one/two/three/four/five/six", "one/two/three/four/five/six/seven"],
		);
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("scan skips submodule and linked-worktree gitfiles but keeps a separate git dir", async () => {
	mkdirSync(join(work, "sub"));
	writeFileSync(join(work, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
	mkdirSync(join(work, "tree"));
	writeFileSync(join(work, "tree", ".git"), "gitdir: /repos/main/.git/worktrees/tree\n");
	mkdirSync(join(work, "separate"));
	writeFileSync(join(work, "separate", ".git"), "gitdir: /repos/separate.git\n");
	expect((await scanProjectGroup(work)).repositories.map((r) => r.path)).toEqual(["separate"]);
});

test("a large repository working tree does not starve sibling repositories", async () => {
	const big = join(work, "big");
	makeRepo(big);
	// A deep tracked tree inside the repository and a wide untracked artifact tree outside any.
	for (let i = 0; i < 40; i++) {
		const deep = join(big, "src", `m${i}`, "a", "b", "c");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(deep, "f.txt"), "x");
	}
	git(big, "add", "-A");
	git(big, "-c", "user.email=t@thinkrail.test", "-c", "user.name=test", "commit", "-m", "tree");
	for (let i = 0; i < 300; i++)
		mkdirSync(join(work, "artifacts", `run-${i}`, "x"), { recursive: true });
	makeRepo(join(work, "artifacts", "run-7", "helmet"));
	for (const name of ["zz-a", "zz-b", "zz-c"]) makeRepo(join(work, "workbench", name));
	// Budget enough for the plain folders, not for walking the tracked tree as well.
	const scan = await scanProjectGroup(work, { maxDirectories: 700 });
	expect(scan.truncated).toBe(false);
	expect(scan.repositories.map((r) => r.path)).toEqual([
		"big",
		"workbench/zz-a",
		"workbench/zz-b",
		"workbench/zz-c",
		"artifacts/run-7/helmet",
	]);
});

test("scan finds repositories nested in a repository's untracked or ignored folders", async () => {
	const parent = join(work, "parent");
	makeRepo(parent);
	writeFileSync(join(parent, ".gitignore"), "vendor/\n");
	mkdirSync(join(parent, "src", "lib"), { recursive: true });
	writeFileSync(join(parent, "src", "lib", "a.c"), "");
	git(parent, "add", "-A");
	git(parent, "-c", "user.email=t@thinkrail.test", "-c", "user.name=test", "commit", "-m", "src");
	makeRepo(join(parent, "vendor", "x", "y"));
	makeRepo(join(parent, "src", "lib", "plugin"));
	makeRepo(join(parent, "tools"));
	expect((await scanProjectGroup(work)).repositories.map((r) => r.path)).toEqual([
		"parent",
		"parent/tools",
		"parent/src/lib/plugin",
		"parent/vendor/x/y",
	]);
});

test("scan finds well over 64 repositories", async () => {
	for (let i = 0; i < 120; i++) makeRepo(join(work, `group-${Math.floor(i / 10)}`, `repo-${i}`));
	const scan = await scanProjectGroup(work);
	expect(scan.truncated).toBe(false);
	expect(scan.repositories).toHaveLength(120);
});

test("a repo tool checkout is read from .repo/project.list, symlinked .git included", async () => {
	const root = join(work, "aosp");
	const store = join(root, ".repo", "projects");
	const projects = ["build_system", "device/acme/board", "hardware/camera", "external/zlib"];
	for (const path of projects) {
		const gitdir = join(store, `${path}.git`);
		mkdirSync(join(gitdir, ".."), { recursive: true });
		git(join(gitdir, ".."), "init", "--bare", "-q", gitdir);
		mkdirSync(join(root, path), { recursive: true });
		symlinkSync(gitdir, join(root, path, ".git"), "dir");
	}
	// `repo init --worktree` style: a gitfile into the .repo store's worktrees.
	mkdirSync(join(root, "common"), { recursive: true });
	writeFileSync(
		join(root, "common", ".git"),
		`gitdir: ${join(root, ".repo", "worktrees", "common.git", "worktrees", "common")}\n`,
	);
	// Listed but gone, and an unsafe entry: both dropped.
	writeFileSync(
		join(root, ".repo", "project.list"),
		`${[...projects, "common", "missing/project", "../escape", ".hidden/x"].join("\n")}\n`,
	);
	// An ad-hoc clone outside the manifest is still found by the walk.
	makeRepo(join(root, "workbench", "bringup", "tool"));
	const scan = await scanProjectGroup(root);
	expect(scan.truncated).toBe(false);
	expect(scan.repositories.map((r) => r.path)).toEqual([
		"build_system",
		"common",
		"external/zlib",
		"hardware/camera",
		"device/acme/board",
		"workbench/bringup/tool",
	]);
});

test("scan reports truncation when a budget stops it", async () => {
	for (const name of ["a", "b", "c"]) makeRepo(join(work, name));
	const scan = await scanProjectGroup(work, { maxRepositories: 2 });
	expect(scan.truncated).toBe(true);
	expect(scan.repositories).toHaveLength(2);
	expect((await scanProjectGroup(work, { maxDirectories: 1 })).truncated).toBe(true);
});

test("scan rejects a relative, missing or non-folder path", async () => {
	await expect(scanProjectGroup("relative/path")).rejects.toThrow();
	await expect(scanProjectGroup(join(work, "missing"))).rejects.toThrow("No such folder");
	writeFileSync(join(work, "file"), "");
	await expect(scanProjectGroup(join(work, "file"))).rejects.toThrow("Not a folder");
});

test("import opens kept repositories as projects that share one persisted group", async () => {
	const root = join(work, "suite");
	makeRepo(root);
	makeRepo(join(root, "app"));
	makeRepo(join(root, "libs", "core"));
	const published: Project[] = [];
	setProjectPublisher((project) => published.push(project));
	const result = await importProjectGroup({ root, paths: ["libs/core", ""], name: "  My  suite " });
	expect(result.failed).toEqual([]);
	expect(result.projects.map((p) => p.projectGroup?.path)).toEqual(["", "libs/core"]);
	const [rootProject, core] = result.projects;
	const groupId = rootProject?.projectGroup?.id;
	expect(groupId).toBeString();
	for (const project of getProjects()) {
		expect(project.projectGroup).toEqual({
			id: groupId ?? "",
			name: "My suite",
			root,
			path: project.path === root ? "" : "libs/core",
		});
	}
	expect(published.at(-1)?.projectGroup?.path).toBe("libs/core");
	expect(projectGroupMembers(core?.id ?? "").map((p) => p.id)).toEqual([rootProject?.id ?? ""]);

	const again = await importProjectGroup({ root, paths: ["app"] });
	expect(again.projects[0]?.projectGroup).toEqual({
		id: groupId ?? "",
		name: "My suite",
		root,
		path: "app",
	});
	expect(projectGroupMembers(rootProject?.id ?? "").map((p) => p.projectGroup?.path)).toEqual([
		"app",
		"libs/core",
	]);
	closeProject(again.projects[0]?.id ?? "");
	expect(projectGroupMembers(rootProject?.id ?? "").map((p) => p.projectGroup?.path)).toEqual([
		"libs/core",
	]);
});

test("a re-scan offers the group's name and a rename on re-import reaches every member", async () => {
	const root = join(work, "suite");
	makeRepo(root);
	makeRepo(join(root, "app"));
	makeRepo(join(root, "api"));
	await importProjectGroup({ root, paths: ["", "app", "api"], name: "Platform" });
	expect((await scanProjectGroup(root)).name).toBe("Platform");
	expect((await scanProjectGroup(root)).repositories[0]).toEqual({ path: "", name: "suite" });
	const published: Project[] = [];
	setProjectPublisher((project) => published.push(project));
	await importProjectGroup({ root, paths: ["app"], name: "Platform 2" });
	expect(getProjects().map((p) => p.projectGroup?.name)).toEqual([
		"Platform 2",
		"Platform 2",
		"Platform 2",
	]);
	expect(new Set(getProjects().map((p) => p.projectGroup?.id)).size).toBe(1);
	expect([...new Set(published.map((p) => p.projectGroup?.path))].sort()).toEqual([
		"",
		"api",
		"app",
	]);
});

test("import refuses a path a fresh scan does not find and reports per-repository failures", async () => {
	makeRepo(join(work, "app"));
	makeRepo(join(work, "api"));
	await expect(importProjectGroup({ root: work, paths: ["../escape"] })).rejects.toThrow(
		"Invalid project group import",
	);
	await expect(importProjectGroup({ root: work, paths: [] })).rejects.toThrow();
	await expect(importProjectGroup({ root: "relative", paths: ["app"] })).rejects.toThrow();
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([
			{
				id: "ws-1",
				projectId: "p-other",
				name: "seeded",
				branch: "seeded",
				worktreePath: join(work, "api"),
				baseBranch: "main",
			},
		]),
	);
	const result = await importProjectGroup({ root: work, paths: ["api", "app"] });
	expect(result.projects.map((p) => p.projectGroup?.path)).toEqual(["app"]);
	expect(result.failed.map((f) => f.path)).toEqual(["api"]);
	expect(result.failed[0]?.reason).toContain("already open");
});

test("removing a group strips membership, optionally closes members, and never touches folders", async () => {
	const root = join(work, "suite");
	makeRepo(root);
	makeRepo(join(root, "app"));
	makeRepo(join(root, "libs", "core"));
	const imported = await importProjectGroup({ root, paths: ["", "app", "libs/core"] });
	const groupId = imported.projects[0]?.projectGroup?.id ?? "";
	expect(projectGroupProjects(groupId).map((p) => p.projectGroup?.path)).toEqual([
		"",
		"app",
		"libs/core",
	]);
	closeProject(imported.projects[2]?.id ?? "");
	expect(projectGroupProjects(groupId)).toHaveLength(2);

	const kept = removeProjectGroup({ groupId, close: false });
	expect(kept.projects).toHaveLength(3);
	expect(kept.projects.every((p) => p.projectGroup === undefined)).toBe(true);
	expect(getProjects().filter((p) => p.closed !== true)).toHaveLength(2);
	expect(projectGroupProjects(groupId)).toEqual([]);
	expect(() => removeProjectGroup({ groupId, close: false })).toThrow("Unknown project group");

	const again = await importProjectGroup({ root, paths: ["", "app"] });
	const nextId = again.projects[0]?.projectGroup?.id ?? "";
	const closed = removeProjectGroup({ groupId: nextId, close: true });
	expect(closed.projects.map((p) => p.closed)).toEqual([true, true]);
	expect(getProjects().every((p) => p.projectGroup === undefined)).toBe(true);
	expect(Bun.spawnSync(["git", "-C", join(root, "app"), "rev-parse", "HEAD"]).success).toBe(true);
	expect(() => removeProjectGroup({ groupId: "", close: true })).toThrow();
});
