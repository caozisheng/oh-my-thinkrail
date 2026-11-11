import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@thinkrail/contracts";
import {
	freshBaseRef,
	groupReferenceCandidates,
	groupWorkspaceLayout,
	worktreeUnchanged,
} from "./issuesActions";

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

test("an Issue's references are the open, trusted other members of its group", () => {
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
	expect(groupReferenceCandidates("core")).toEqual(["root", "app"]);
	expect(groupReferenceCandidates("loose")).toEqual([]);
});

test("a layout needs every participant in the group at its place and also places joinable members", () => {
	seed([member("root", ""), member("app", "app"), member("core", "libs/core")]);
	expect(groupWorkspaceLayout("app", ["app", "core"])).toEqual({
		root: suite,
		paths: [
			{ projectId: "app", path: "app" },
			{ projectId: "core", path: "libs/core" },
			{ projectId: "root", path: "" },
		],
	});
	expect(groupWorkspaceLayout("app", ["app"])?.paths.map((p) => p.projectId)).toEqual([
		"app",
		"root",
		"core",
	]);
	seed([
		member("app", "app"),
		member("core", "libs/core"),
		member("closed", "closed", { closed: true }),
		{
			...member("moved", "moved"),
			projectGroup: { id: "g1", name: "suite", root: suite, path: "elsewhere" },
		},
		{
			...member("other", "other"),
			projectGroup: { id: "g2", name: "x", root: suite, path: "other" },
		},
	]);
	// A member that moved, closed or belongs elsewhere is not placed; as a participant it voids the layout.
	expect(groupWorkspaceLayout("app", ["app"])?.paths.map((p) => p.path)).toEqual([
		"app",
		"libs/core",
	]);
	expect(groupWorkspaceLayout("app", ["app", "moved"])).toBeNull();
	expect(groupWorkspaceLayout("app", ["app", "other"])).toBeNull();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	}).trim();
}
function repo(path: string, branch = "main"): string {
	mkdirSync(path, { recursive: true });
	git(path, "init", "-q", "-b", branch);
	writeFileSync(join(path, "README.md"), "x\n");
	git(path, "add", "-A");
	git(path, "commit", "-qm", "init");
	return path;
}

test("a fresh base fetches origin's default branch and falls back to local HEAD without one", async () => {
	const upstream = repo(join(dataDir, "upstream"), "develop");
	const local = join(dataDir, "local");
	git(dataDir, "clone", "-q", upstream, local);
	writeFileSync(join(upstream, "later.md"), "y\n");
	git(upstream, "add", "-A");
	git(upstream, "commit", "-qm", "later");
	expect(await freshBaseRef(local)).toBe("origin/develop");
	expect(git(local, "rev-parse", "origin/develop")).toBe(git(upstream, "rev-parse", "HEAD"));
	expect(await freshBaseRef(repo(join(dataDir, "alone")))).toBeUndefined();
	const offline = join(dataDir, "offline");
	git(dataDir, "clone", "-q", upstream, offline);
	rmSync(upstream, { recursive: true, force: true });
	// An unreachable origin keeps the last-known remote ref rather than failing.
	expect(await freshBaseRef(offline)).toBe("origin/develop");
});

test("a worktree is unchanged only without commits beyond its base and without tree changes", async () => {
	const path = repo(join(dataDir, "member"));
	const base = git(path, "rev-parse", "HEAD");
	expect(await worktreeUnchanged(path, base)).toBe(true);
	expect(await worktreeUnchanged(path, "HEAD")).toBe(false);
	writeFileSync(join(path, ".gitignore"), "build/\n");
	expect(await worktreeUnchanged(path, base)).toBe(false);
	git(path, "add", "-A");
	git(path, "commit", "-qm", "ignore");
	expect(await worktreeUnchanged(path, base)).toBe(false);
	const next = git(path, "rev-parse", "HEAD");
	mkdirSync(join(path, "build"));
	writeFileSync(join(path, "build", "out.js"), "1");
	expect(await worktreeUnchanged(path, next)).toBe(true);
	writeFileSync(join(path, "README.md"), "changed\n");
	expect(await worktreeUnchanged(path, next)).toBe(false);
});
