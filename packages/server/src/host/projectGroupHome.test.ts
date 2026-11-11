import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@thinkrail/contracts";
import type { GroupIssueRecord } from "./issues";
import {
	fetchProjectGroup,
	issueStartCommit,
	parseBranchStatus,
	parseWorktreeStatus,
	projectGroupStatus,
} from "./projectGroupHome";

let dataDir: string;
let suite: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-C", cwd, "-c", "user.email=t@thinkrail.test", "-c", "user.name=test", ...args],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	).trim();
}

function repo(path: string): string {
	const folder = path ? join(suite, ...path.split("/")) : suite;
	mkdirSync(folder, { recursive: true });
	git(folder, "init", "-q", "-b", "main");
	git(folder, "commit", "-q", "--allow-empty", "-m", "init");
	return folder;
}

function member(id: string, path: string, extra: Partial<Project> = {}): Project {
	return {
		id,
		name: id,
		path: path ? join(suite, ...path.split("/")) : suite,
		slug: id,
		lastOpened: 1,
		projectGroup: { id: "g1", name: "suite", root: suite, path },
		...extra,
	};
}

beforeEach(() => {
	dataDir = realpathSync.native(mkdtempSync(join(tmpdir(), "trpi-group-home-")));
	suite = join(dataDir, "suite");
	process.env.THINKRAIL_DATA_DIR = dataDir;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("porcelain v2 branch headers parse into branch, upstream divergence and dirtiness", () => {
	expect(
		parseBranchStatus(
			"# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n",
		),
	).toEqual({ branch: "main", dirty: false, upstream: "origin/main", ahead: 2, behind: 3 });
	expect(parseBranchStatus("# branch.head main\n? libs/\n? app/\n", ["app", "libs/core"])).toEqual({
		branch: "main",
		dirty: false,
	});
	expect(parseBranchStatus("# branch.head main\n? docs/\n", ["app"]).dirty).toBe(true);
	expect(parseBranchStatus("# branch.oid abc\n# branch.head (detached)\n? new.txt\n")).toEqual({
		branch: null,
		dirty: true,
	});
});

test("group status reads every open member's checkout and passes the members' Issues through", async () => {
	repo("");
	const remote = join(dataDir, "remote.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	const app = repo("app");
	git(app, "remote", "add", "origin", remote);
	git(app, "push", "-q", "-u", "origin", "main");
	git(app, "commit", "-q", "--allow-empty", "-m", "local");
	const core = repo("libs/core");
	writeFileSync(join(core, "dirty.txt"), "x");
	git(core, "checkout", "-q", "-b", "feature");
	writeFileSync(
		join(dataDir, "projects.json"),
		JSON.stringify([
			member("app", "app"),
			member("root", ""),
			member("core", "libs/core"),
			member("closed", "closed", { closed: true }),
			{ ...member("other", "x"), projectGroup: { id: "g2", name: "o", root: suite, path: "x" } },
		]),
	);
	let asked: string[] = [];
	const records: GroupIssueRecord[] = [
		{
			provider: "gitlab",
			instanceUrl: "https://gitlab.example",
			number: 7,
			projectId: "app",
			repositories: [
				{ projectId: "app", role: "primary", workspaceId: "missing" },
				{ projectId: "core", role: "associated", workspaceId: "gone", base: "a".repeat(40) },
			],
		},
	];
	const status = await projectGroupStatus({ groupId: "g1" }, (ids) => {
		asked = [...ids].sort();
		return records;
	});
	expect(asked).toEqual(["app", "core", "root"]);
	expect(status).toMatchObject({ id: "g1", name: "suite", root: suite });
	expect(status.repositories).toEqual([
		{ projectId: "root", path: "", branch: "main", dirty: false },
		{
			projectId: "app",
			path: "app",
			branch: "main",
			dirty: false,
			upstream: "origin/main",
			ahead: 1,
			behind: 0,
		},
		{ projectId: "core", path: "libs/core", branch: "feature", dirty: true },
	]);
	expect(status.issues).toEqual([
		{
			provider: "gitlab",
			instanceUrl: "https://gitlab.example",
			number: 7,
			projectId: "app",
			repositories: [
				{ projectId: "app", role: "primary", workspaceId: "missing", path: "app" },
				{ projectId: "core", role: "associated", workspaceId: "gone", path: "libs/core" },
			],
		},
	]);
	const failing = await projectGroupStatus({ groupId: "g1" }, () => {
		throw new Error("reconcile");
	});
	expect(failing.issues).toEqual([]);
	await expect(projectGroupStatus({ groupId: "nope" }, () => [])).rejects.toThrow(
		"Unknown project group",
	);
	await expect(projectGroupStatus({ groupId: "" }, () => [])).rejects.toMatchObject({
		code: "RANGE_INVALID",
	});
});

test("worktree status counts changed paths, skipping the Issue's nested worktrees", () => {
	expect(
		parseWorktreeStatus(
			"# branch.oid abc\n# branch.head issue-7\n# branch.upstream origin/issue-7\n# branch.ab +1 -0\n1 .M N... 100644 100644 100644 a b src/a.ts\n? modules/invoice/core/\n? notes.md\n",
			["modules/invoice/core"],
		),
	).toEqual({ changedFiles: 2, upstream: "origin/issue-7", upstreamAhead: 1, upstreamBehind: 0 });
	expect(parseWorktreeStatus("# branch.head issue-7\n")).toEqual({ changedFiles: 0 });
});

test("an Issue's primary starts at its branch's creation, else at the merge-base with the default branch", async () => {
	const app = repo("app");
	git(app, "commit", "-q", "--allow-empty", "-m", "second");
	const start = git(app, "rev-parse", "HEAD");
	git(app, "branch", "issue-1", start);
	git(app, "checkout", "-q", "issue-1");
	git(app, "commit", "-q", "--allow-empty", "-m", "work");
	expect(await issueStartCommit(app, "issue-1", undefined, "main")).toEqual({
		base: start,
		source: "created",
	});
	expect(await issueStartCommit(app, "issue-1", "b".repeat(40), "main")).toEqual({
		base: "b".repeat(40),
		source: "recorded",
	});
	// No reflog (expired or disabled): fall back to the merge-base with the default branch.
	rmSync(join(app, ".git", "logs"), { recursive: true, force: true });
	expect(await issueStartCommit(app, "issue-1", undefined, "main")).toEqual({
		base: start,
		source: "mergeBase",
	});
	expect(await issueStartCommit(app, "issue-1", undefined, undefined)).toBeUndefined();
});

test("group status measures each Issue worktree against its start and the default branch", async () => {
	repo("");
	const remote = join(dataDir, "billing.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	const billing = repo("services/billing");
	git(billing, "remote", "add", "origin", remote);
	git(billing, "push", "-q", "-u", "origin", "main");
	const gateway = repo("services/gateway");
	const auth = repo("services/auth");
	const slot = join(suite, ".worktrees", "issue-7");
	const wt = (from: string, path: string) => {
		const target = join(slot, ...path.split("/"));
		mkdirSync(join(target, ".."), { recursive: true });
		git(from, "worktree", "add", "-q", "-b", "issue-7", target, "HEAD");
		return target;
	};
	const gatewayWt = wt(gateway, "services/gateway");
	const billingWt = wt(billing, "services/billing");
	const billingBase = git(billingWt, "rev-parse", "HEAD");
	git(billingWt, "commit", "-q", "--allow-empty", "-m", "one");
	git(billingWt, "commit", "-q", "--allow-empty", "-m", "two");
	writeFileSync(join(billingWt, "wip.txt"), "x");
	const authWt = wt(auth, "services/auth");
	const authBase = git(authWt, "rev-parse", "HEAD");
	// The default branch moved on since billing joined.
	git(billing, "commit", "-q", "--allow-empty", "-m", "upstream");
	git(billing, "push", "-q", "origin", "main");
	git(billing, "fetch", "-q", "origin");
	const ws = (id: string, projectId: string, worktreePath: string) => ({
		id,
		projectId,
		name: "issue-7",
		branch: "issue-7",
		worktreePath,
		baseBranch: "main",
	});
	writeFileSync(
		join(dataDir, "projects.json"),
		JSON.stringify([
			member("root", ""),
			member("gateway", "services/gateway"),
			member("billing", "services/billing"),
			member("auth", "services/auth"),
		]),
	);
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([
			ws("w-gateway", "gateway", gatewayWt),
			ws("w-billing", "billing", billingWt),
			ws("w-auth", "auth", authWt),
		]),
	);
	const status = await projectGroupStatus({ groupId: "g1" }, () => [
		{
			provider: "gitlab",
			instanceUrl: "https://gitlab.example",
			number: 7,
			title: "Split invoices",
			projectId: "gateway",
			repositories: [
				{ projectId: "gateway", role: "primary", workspaceId: "w-gateway" },
				{ projectId: "billing", role: "associated", workspaceId: "w-billing", base: billingBase },
				{ projectId: "auth", role: "associated", workspaceId: "w-auth", base: authBase },
			],
		},
	]);
	const issue = status.issues[0];
	expect(issue?.title).toBe("Split invoices");
	expect(issue?.repositories).toEqual([
		{
			projectId: "gateway",
			role: "primary",
			workspaceId: "w-gateway",
			path: "services/gateway",
			branch: "issue-7",
			changedFiles: 0,
			baseSource: "created",
			ahead: 0,
			behind: 0,
			defaultBranch: "main",
			changed: false,
		},
		{
			projectId: "billing",
			role: "associated",
			workspaceId: "w-billing",
			path: "services/billing",
			branch: "issue-7",
			changedFiles: 1,
			baseSource: "recorded",
			ahead: 2,
			behind: 1,
			defaultBranch: "origin/main",
			changed: true,
		},
		{
			projectId: "auth",
			role: "associated",
			workspaceId: "w-auth",
			path: "services/auth",
			branch: "issue-7",
			changedFiles: 0,
			baseSource: "recorded",
			ahead: 0,
			behind: 0,
			defaultBranch: "main",
			changed: false,
		},
	]);
});

test("fetch all reports fetched, no-remote and failed members without stopping", async () => {
	repo("");
	const remote = join(dataDir, "remote.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	const app = repo("app");
	git(app, "remote", "add", "origin", remote);
	git(app, "push", "-q", "origin", "main");
	const broken = repo("broken");
	git(broken, "remote", "add", "origin", join(dataDir, "missing.git"));
	writeFileSync(
		join(dataDir, "projects.json"),
		JSON.stringify([member("root", ""), member("app", "app"), member("broken", "broken")]),
	);
	const { results } = await fetchProjectGroup({ groupId: "g1" });
	expect(results.map(({ projectId, outcome }) => [projectId, outcome])).toEqual([
		["root", "noRemote"],
		["app", "fetched"],
		["broken", "failed"],
	]);
	expect(results[2]?.error).toBeTruthy();
});
