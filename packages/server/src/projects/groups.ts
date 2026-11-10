import { randomUUID } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
	PROJECT_GROUP_MAX_REPOSITORIES,
	type Project,
	type ProjectGroupImport,
	type ProjectGroupImportInput,
	type ProjectGroupMembership,
	type ProjectGroupScan,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { canonicalPath } from "../git";
import {
	getProjects,
	openProject,
	resolveProjectPath,
	setProjectGroupMembership,
} from "./projects";

export const PROJECT_GROUP_SCAN_DEPTH = 4;
const SCAN_MAX_DIRECTORIES = 10_000;
const SCAN_BUDGET_MS = 5_000;
const GITFILE_MAX_BYTES = 4096;
const GROUP_NAME_MAX_LENGTH = 100;

/** Dependency, build and cache folders that never hold a repository worth importing. */
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"bower_components",
	"vendor",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	"venv",
	"__pycache__",
]);

export interface ProjectGroupScanOptions {
	maxDepth?: number;
	maxDirectories?: number;
	maxRepositories?: number;
	budgetMs?: number;
}

function toGroupPath(path: string): string {
	return path.split(sep).join("/");
}

function fromGroupPath(root: string, path: string): string {
	return path ? join(root, ...path.split("/")) : root;
}

function depthOf(path: string): number {
	return path ? path.split("/").length : 0;
}

function shallowFirst(a: string, b: string): number {
	return depthOf(a) - depthOf(b) || a.localeCompare(b);
}

async function readHead(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(GITFILE_MAX_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, GITFILE_MAX_BYTES, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/**
 * A real `.git` directory, or a gitfile that is neither a submodule (`…/modules/…`) nor a linked
 * worktree (`…/worktrees/…`). A symlinked `.git` is never followed.
 */
async function isRepositoryRoot(dir: string): Promise<boolean> {
	const marker = join(dir, ".git");
	const entry = await lstat(marker).catch(() => null);
	if (!entry) return false;
	if (entry.isDirectory()) return true;
	if (!entry.isFile()) return false;
	const text = await readHead(marker).catch(() => "");
	const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
	if (!gitdir) return false;
	return !/(^|\/)(modules|worktrees)\//.test(`${gitdir.replace(/\\/g, "/")}/`);
}

/**
 * Breadth-first walk below `inputPath` for nested repositories. Hidden folders (including `.git`
 * and `.worktrees`), dependency/build folders and symlinks are never entered; the walk is bounded
 * by depth, directories read, repositories found and wall time, and reports `truncated` when one
 * of the last three stopped it.
 */
export async function scanProjectGroup(
	inputPath: string,
	options: ProjectGroupScanOptions = {},
): Promise<ProjectGroupScan> {
	const maxDepth = options.maxDepth ?? PROJECT_GROUP_SCAN_DEPTH;
	const maxDirectories = options.maxDirectories ?? SCAN_MAX_DIRECTORIES;
	const maxRepositories = options.maxRepositories ?? PROJECT_GROUP_MAX_REPOSITORIES;
	const deadline = Date.now() + (options.budgetMs ?? SCAN_BUDGET_MS);
	const resolved = resolveProjectPath(inputPath);
	if (!(await lstat(resolved).catch(() => null))) throw new Error(`No such folder: ${resolved}`);
	const root = await realpath(resolved);
	if (!(await lstat(root)).isDirectory()) throw new Error(`Not a folder: ${resolved}`);

	const found: string[] = [];
	const queue: string[] = [""];
	let read = 0;
	let truncated = false;
	while (queue.length > 0) {
		if (found.length >= maxRepositories || read >= maxDirectories || Date.now() > deadline) {
			truncated = true;
			break;
		}
		const path = queue.shift() ?? "";
		const dir = fromGroupPath(root, path);
		if (await isRepositoryRoot(dir)) found.push(path);
		if (depthOf(path) >= maxDepth) continue;
		read += 1;
		const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!child.isDirectory() || child.isSymbolicLink()) continue;
			if (child.name.startsWith(".") || SKIPPED_DIRECTORIES.has(child.name)) continue;
			queue.push(path ? `${path}/${child.name}` : child.name);
		}
	}
	const folderName = basename(root) || root;
	return {
		root,
		// Re-scanning an imported root offers its current group name, so confirming keeps it.
		name: existingGroup(root)?.name ?? folderName,
		repositories: found
			.sort(shallowFirst)
			.map((path) => ({ path, name: path ? basename(path) : folderName })),
		truncated,
	};
}

function groupName(requested: string | undefined, fallback: string): string {
	const name = requested?.replace(/\s+/g, " ").trim();
	return name && name.length <= GROUP_NAME_MAX_LENGTH ? name : fallback;
}

function existingGroup(root: string): ProjectGroupMembership | undefined {
	const rootKey = canonicalPath(root);
	return getProjects().find(
		(project) => project.projectGroup && canonicalPath(project.projectGroup.root) === rootKey,
	)?.projectGroup;
}

function invalidImport(): never {
	throw new CodedError("RANGE_INVALID", "Invalid project group import.");
}

/**
 * Open every kept candidate as an ordinary project (so `ALREADY_OPEN` and the path guard still
 * apply) and record its group membership. A fresh scan re-derives the candidates: a path the
 * client names that the scan no longer finds is refused rather than opened.
 */
export async function importProjectGroup(
	input: ProjectGroupImportInput,
): Promise<ProjectGroupImport> {
	if (
		typeof input?.root !== "string" ||
		!isAbsolute(input.root) ||
		!Array.isArray(input.paths) ||
		input.paths.length === 0 ||
		input.paths.length > PROJECT_GROUP_MAX_REPOSITORIES ||
		input.paths.some((path) => typeof path !== "string") ||
		new Set(input.paths).size !== input.paths.length ||
		(input.name !== undefined && typeof input.name !== "string")
	)
		invalidImport();
	const scan = await scanProjectGroup(input.root);
	const known = new Set(scan.repositories.map((repository) => repository.path));
	if (input.paths.some((path) => !known.has(path))) invalidImport();
	const existing = existingGroup(scan.root);
	const id = existing?.id ?? randomUUID();
	const name = groupName(input.name, existing?.name ?? scan.name);
	const projects: Project[] = [];
	const failed: ProjectGroupImport["failed"] = [];
	for (const path of [...input.paths].sort(shallowFirst)) {
		const folder = fromGroupPath(scan.root, path);
		try {
			const project = openProject(folder);
			const actual = toGroupPath(relative(scan.root, await realpath(project.path)));
			if (actual !== path)
				throw new Error(`${folder} belongs to the repository at ${project.path}`);
			projects.push(setProjectGroupMembership(project.id, { id, name, root: scan.root, path }));
		} catch (error) {
			failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	// One group has one name: a rename on re-import reaches the members this import did not touch.
	const imported = new Set(projects.map((project) => project.id));
	for (const project of getProjects()) {
		const group = project.projectGroup;
		if (group?.id === id && group.name !== name && !imported.has(project.id))
			setProjectGroupMembership(project.id, { ...group, name });
	}
	return { projects, failed };
}

/** The other open members of `projectId`'s group, shallow-first. */
export function projectGroupMembers(projectId: string): Project[] {
	const projects = getProjects();
	const group = projects.find((project) => project.id === projectId)?.projectGroup;
	if (!group) return [];
	return projects
		.filter(
			(project) =>
				project.id !== projectId &&
				project.closed !== true &&
				project.projectGroup?.id === group.id,
		)
		.sort((a, b) => shallowFirst(a.projectGroup?.path ?? "", b.projectGroup?.path ?? ""));
}
