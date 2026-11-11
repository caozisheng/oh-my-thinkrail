import { randomUUID } from "node:crypto";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
	PROJECT_GROUP_MAX_REPOSITORIES,
	type Project,
	type ProjectGroupImport,
	type ProjectGroupImportInput,
	type ProjectGroupMembership,
	type ProjectGroupRemove,
	type ProjectGroupRemoveInput,
	type ProjectGroupScan,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { canonicalPath, gitAsync } from "../git";
import {
	closeProject,
	getProjects,
	openProject,
	resolveProjectPath,
	setProjectGroupMembership,
} from "./projects";

export const PROJECT_GROUP_SCAN_DEPTH = 10;
const SCAN_MAX_DIRECTORIES = 50_000;
const SCAN_BUDGET_MS = 20_000;
/** Directories read (or repositories enumerated) at once. */
const SCAN_CONCURRENCY = 16;
/** A scan an import can reuse instead of walking the folder again. */
const SCAN_REUSE_MS = 10 * 60_000;
const GITFILE_MAX_BYTES = 4096;
const PROJECT_LIST_MAX_BYTES = 1024 * 1024;
const GROUP_NAME_MAX_LENGTH = 100;

/** Dependency, build and cache folders that never hold a repository worth importing. */
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"bower_components",
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

function childPath(parent: string, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

function walkable(name: string): boolean {
	return name !== "" && !name.startsWith(".") && !SKIPPED_DIRECTORIES.has(name);
}

async function readHead(path: string, maxBytes = GITFILE_MAX_BYTES): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

async function isGitDirectory(path: string): Promise<boolean> {
	const target = await stat(path).catch(() => null);
	if (!target?.isDirectory()) return false;
	return Boolean(await stat(join(path, "HEAD")).catch(() => null));
}

/**
 * A real `.git` directory; a `.git` symlink to a git directory (the `repo` tool links each project's
 * `.git` into `.repo/projects/…`); or a gitfile that is neither a submodule (`…/modules/…`) nor a
 * linked worktree (`…/worktrees/…`) — except that gitfiles into a `.repo/` store (`repo init
 * --worktree`) always count, since those worktrees are the projects themselves.
 */
async function isRepositoryRoot(dir: string): Promise<boolean> {
	const marker = join(dir, ".git");
	const entry = await lstat(marker).catch(() => null);
	if (!entry) return false;
	if (entry.isDirectory()) return true;
	if (entry.isSymbolicLink()) return isGitDirectory(marker);
	if (!entry.isFile()) return false;
	const text = await readHead(marker).catch(() => "");
	const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1]?.replace(/\\/g, "/");
	if (!gitdir) return false;
	if (/(^|\/)\.repo\//.test(gitdir)) return true;
	return !/(^|\/)(modules|worktrees)\//.test(`${gitdir}/`);
}

/** Any `.git` entry at all: enough for a folder the `repo` manifest itself names as a project. */
async function hasGitMarker(dir: string): Promise<boolean> {
	return Boolean(await lstat(join(dir, ".git")).catch(() => null));
}

/**
 * The project paths a `repo` tool checkout lists in `.repo/project.list` (one root-relative path
 * per line), kept only when safe (relative, no `..`/hidden segments) and holding a `.git`.
 */
async function repoToolProjects(root: string, maxDepth: number): Promise<string[]> {
	const text = await readHead(join(root, ".repo", "project.list"), PROJECT_LIST_MAX_BYTES).catch(
		() => "",
	);
	const paths = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const path = line.trim().replace(/\\/g, "/").replace(/\/+$/, "");
		if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) continue;
		const segments = path.split("/");
		if (segments.some((segment) => segment === "" || segment.startsWith("."))) continue;
		if (segments.length > maxDepth) continue;
		paths.add(path);
	}
	const checked = await Promise.all(
		[...paths].map(async (path) => ((await hasGitMarker(fromGroupPath(root, path))) ? path : null)),
	);
	return checked.filter((path): path is string => path !== null);
}

/**
 * The folders inside repository `dir` that its index does not track (untracked or ignored, nested
 * repositories included), as repository-relative paths; git collapses a wholly untracked folder
 * into one entry, so the tracked working tree is never walked here. Null when git cannot answer.
 */
async function untrackedFolders(dir: string, timeoutMs: number): Promise<string[] | null> {
	const result = await gitAsync(
		dir,
		["-c", "core.fsmonitor=false", "ls-files", "-z", "--others", "--directory"],
		{ raw: true, timeoutMs: Math.max(1_000, timeoutMs) },
	);
	if (!result.ok) return null;
	return result.out
		.split("\0")
		.filter((entry) => entry.endsWith("/"))
		.map((entry) => entry.slice(0, -1));
}

type ScanTask = { path: string; kind: "folder" | "repository" | "tracked" };

/**
 * Walk below `inputPath` for nested repositories. A `repo` tool checkout's `.repo/project.list`
 * seeds the result. Plain folders are read breadth-first; a repository is not walked through its
 * tracked tree — git names the folders its index does not track, and only those are walked
 * further — and that enumeration waits until every plain folder is done, so one huge repository
 * cannot starve its siblings. (When git cannot answer, the repository's folders are read like plain
 * ones, still after everything else.) Hidden folders (including `.git`, `.repo` and `.worktrees`),
 * dependency/build folders and symlinks are never entered; the walk is bounded by depth,
 * directories read, repositories found and wall time, and reports `truncated` when one of the last
 * three stopped it.
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

	const found = new Set<string>();
	const manifest = new Set(await repoToolProjects(root, maxDepth));
	for (const path of manifest) found.add(path);
	const seen = new Set<string>([""]);
	const folders: ScanTask[] = [{ path: "", kind: "folder" }];
	const deferred: ScanTask[] = [];
	let read = 0;
	let truncated = false;

	const enqueue = (path: string, kind: ScanTask["kind"]) => {
		if (seen.has(path)) return;
		seen.add(path);
		(kind === "folder" ? folders : deferred).push({ path, kind });
	};
	const readChildren = async (task: ScanTask) => {
		const dir = fromGroupPath(root, task.path);
		const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!child.isDirectory() || child.isSymbolicLink() || !walkable(child.name)) continue;
			const path = childPath(task.path, child.name);
			if (manifest.has(path)) enqueue(path, "repository");
			else enqueue(path, task.kind === "tracked" ? "tracked" : "folder");
		}
	};
	const visit = async (task: ScanTask) => {
		const dir = fromGroupPath(root, task.path);
		if (task.kind === "repository") {
			const untracked = await untrackedFolders(dir, deadline - Date.now());
			if (untracked === null) {
				await readChildren({ path: task.path, kind: "tracked" });
				return;
			}
			for (const entry of untracked) {
				const path = childPath(task.path, entry);
				if (depthOf(path) > maxDepth || !path.split("/").every(walkable)) continue;
				enqueue(path, manifest.has(path) ? "repository" : "folder");
			}
			return;
		}
		if (manifest.has(task.path) || (await isRepositoryRoot(dir))) {
			found.add(task.path);
			if (depthOf(task.path) < maxDepth) {
				// Re-queue the repository itself for the deferred, untracked-only enumeration.
				deferred.push({ path: task.path, kind: "repository" });
			}
			return;
		}
		if (depthOf(task.path) >= maxDepth) return;
		await readChildren(task);
	};

	while (folders.length > 0 || deferred.length > 0) {
		if (found.size >= maxRepositories || read >= maxDirectories || Date.now() > deadline) {
			truncated = true;
			break;
		}
		const queue = folders.length > 0 ? folders : deferred;
		const batch = queue.splice(0, Math.min(SCAN_CONCURRENCY, maxDirectories - read));
		read += batch.length;
		await Promise.all(batch.map(visit));
	}
	const folderName = basename(root) || root;
	const repositories = [...found].sort(shallowFirst).slice(0, maxRepositories);
	if (found.size > maxRepositories) truncated = true;
	const scan: ProjectGroupScan = {
		root,
		// Re-scanning an imported root offers its current group name, so confirming keeps it.
		name: existingGroup(root)?.name ?? folderName,
		repositories: repositories.map((path) => ({ path, name: path ? basename(path) : folderName })),
		truncated,
	};
	recentScans.set(root, { at: Date.now(), paths: new Set(repositories) });
	return scan;
}

/** The last scan of each root, so confirming a slow scan does not repeat it. */
const recentScans = new Map<string, { at: number; paths: Set<string> }>();

async function scannedPaths(root: string): Promise<{ root: string; paths: Set<string> }> {
	const key = await realpath(resolveProjectPath(root)).catch(() => null);
	const recent = key ? recentScans.get(key) : undefined;
	if (key && recent && Date.now() - recent.at < SCAN_REUSE_MS)
		return { root: key, paths: recent.paths };
	const scan = await scanProjectGroup(root);
	return {
		root: scan.root,
		paths: new Set(scan.repositories.map((repository) => repository.path)),
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
	let scan = await scannedPaths(input.root);
	// A path the reused scan lacks gets one fresh scan before the import is refused.
	if (input.paths.some((path) => !scan.paths.has(path))) {
		recentScans.delete(scan.root);
		scan = await scannedPaths(input.root);
	}
	if (input.paths.some((path) => !scan.paths.has(path))) invalidImport();
	const existing = existingGroup(scan.root);
	const id = existing?.id ?? randomUUID();
	const name = groupName(input.name, existing?.name ?? (basename(scan.root) || scan.root));
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

/** The open members of group `groupId`, shallow-first; empty when no open project carries it. */
export function projectGroupProjects(groupId: string): Project[] {
	return getProjects()
		.filter((project) => project.closed !== true && project.projectGroup?.id === groupId)
		.sort((a, b) => shallowFirst(a.projectGroup?.path ?? "", b.projectGroup?.path ?? ""));
}

/**
 * Dissolve a group: every member (open or closed) loses its membership, and with `close` every open
 * member is also closed. Only project records change; no folder, repository or workspace is touched.
 */
export function removeProjectGroup(input: ProjectGroupRemoveInput): ProjectGroupRemove {
	if (
		typeof input?.groupId !== "string" ||
		input.groupId === "" ||
		typeof input.close !== "boolean"
	)
		throw new CodedError("RANGE_INVALID", "Invalid project group removal.");
	const members = getProjects().filter((project) => project.projectGroup?.id === input.groupId);
	if (members.length === 0) throw new Error(`Unknown project group: ${input.groupId}`);
	const projects: Project[] = [];
	for (const member of members) {
		let project = setProjectGroupMembership(member.id, null);
		if (input.close && project.closed !== true) project = closeProject(member.id);
		projects.push(project);
	}
	return { projects };
}
