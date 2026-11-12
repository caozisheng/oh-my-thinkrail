import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@thinkrail/contracts";
import { setTrashImplementationForTests } from "../trash";
import { stopAllWatches } from "../watch";
import { listAllWorkspaceRecords } from "../workspaces";
import { handleRequest } from "./handlers";

const savedDataDir = process.env.THINKRAIL_DATA_DIR;
const ctx = { clientKey: "fs-delete-workspaces" };
let dataDir: string;
let root: string;
let checkout: string;
let trashCalls: string[];

function register(nestedPath = checkout): void {
	const records: Workspace[] = [
		{
			id: "outer",
			projectId: "parent",
			kind: "default",
			name: "Default",
			branch: "main",
			baseBranch: "main",
			worktreePath: root,
		},
		{
			id: "nested",
			projectId: "member",
			name: "Issue checkout",
			branch: "issue-42",
			baseBranch: "main",
			worktreePath: nestedPath,
		},
	];
	writeFileSync(join(dataDir, "workspaces.json"), JSON.stringify(records));
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-fs-delete-workspaces-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	root = join(dataDir, "repo");
	checkout = join(root, ".worktrees", "issue-42", "member");
	mkdirSync(checkout, { recursive: true });
	writeFileSync(join(checkout, "uncommitted.txt"), "keep this work");
	register();
	trashCalls = [];
	setTrashImplementationForTests(async (input) => {
		if (typeof input !== "string") throw new Error("expected one path");
		trashCalls.push(input);
		rmSync(input, { recursive: true });
	});
});

afterEach(() => {
	stopAllWatches();
	setTrashImplementationForTests(undefined);
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

for (const path of [".worktrees/issue-42/member", ".worktrees/issue-42", ".worktrees"]) {
	test(`fs.delete refuses registered checkout or ancestor ${path} before trash`, async () => {
		const records = listAllWorkspaceRecords();
		await expect(
			handleRequest("fs.delete", { workspaceId: "outer", path }, ctx),
		).rejects.toMatchObject({ code: "WORKSPACE_HAS_NESTED_WORKSPACES" });
		expect(trashCalls).toEqual([]);
		expect(readFileSync(join(checkout, "uncommitted.txt"), "utf8")).toBe("keep this work");
		expect(listAllWorkspaceRecords()).toEqual(records);
	});
}

test("fs.delete compares canonical registered roots, including a junction alias", async () => {
	const alias = join(dataDir, "member-alias");
	symlinkSync(checkout, alias, process.platform === "win32" ? "junction" : "dir");
	register(alias);
	await expect(
		handleRequest("fs.delete", { workspaceId: "outer", path: ".worktrees/issue-42" }, ctx),
	).rejects.toMatchObject({ code: "WORKSPACE_HAS_NESTED_WORKSPACES" });
	expect(trashCalls).toEqual([]);
	expect(existsSync(checkout)).toBe(true);
});

test("fs.delete allows ordinary content and same-prefix sibling folders", async () => {
	const sibling = join(root, ".worktrees", "issue-42", "member-copy");
	mkdirSync(sibling);
	writeFileSync(join(sibling, "scratch.txt"), "discard");
	for (const path of [
		".worktrees/issue-42/member-copy",
		".worktrees/issue-42/member/uncommitted.txt",
	]) {
		expect(await handleRequest("fs.delete", { workspaceId: "outer", path }, ctx)).toEqual({
			ok: true,
		});
	}
	expect(trashCalls).toHaveLength(2);
	expect(existsSync(sibling)).toBe(false);
	expect(existsSync(checkout)).toBe(true);
	expect(listAllWorkspaceRecords()).toHaveLength(2);
});
