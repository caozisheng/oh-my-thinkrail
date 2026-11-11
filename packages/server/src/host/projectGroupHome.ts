import type {
	Project,
	ProjectGroupFetch,
	ProjectGroupFetchResult,
	ProjectGroupIssue,
	ProjectGroupIssueRepository,
	ProjectGroupRepositoryStatus,
	ProjectGroupStatus,
	ProjectGroupTarget,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { gitAsync } from "../git";
import { projectGroupProjects } from "../projects";
import { getWorkspace } from "../workspaces";
import type { GroupIssueRecord } from "./issues";

const STATUS_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;
const ERROR_MAX_LENGTH = 300;

async function mapBounded<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
	return results;
}

function members(params: ProjectGroupTarget): Project[] {
	if (typeof params?.groupId !== "string" || params.groupId === "")
		throw new CodedError("RANGE_INVALID", "Invalid project group.");
	const projects = projectGroupProjects(params.groupId);
	if (projects.length === 0) throw new Error(`Unknown project group: ${params.groupId}`);
	return projects;
}

/**
 * Branch, upstream divergence and dirtiness from one `status --porcelain=v2 --branch` read. An
 * untracked folder that is, or holds, one of `nested` (other members, relative to this checkout) is
 * the group's own layout, not a change.
 */
export function parseBranchStatus(
	out: string,
	nested: readonly string[] = [],
): Pick<ProjectGroupRepositoryStatus, "branch" | "dirty" | "upstream" | "ahead" | "behind"> {
	let branch: string | null = null;
	let upstream: string | undefined;
	let ahead: number | undefined;
	let behind: number | undefined;
	let dirty = false;
	for (const line of out.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			const head = line.slice("# branch.head ".length);
			branch = head === "(detached)" ? null : head;
		} else if (line.startsWith("# branch.upstream ")) {
			upstream = line.slice("# branch.upstream ".length);
		} else if (line.startsWith("# branch.ab ")) {
			const match = /^\+(\d+) -(\d+)$/.exec(line.slice("# branch.ab ".length));
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
		} else if (line.startsWith("? ") && line.endsWith("/")) {
			const folder = line.slice(2);
			if (!nested.some((path) => `${path}/`.startsWith(folder))) dirty = true;
		} else if (line !== "" && !line.startsWith("#")) {
			dirty = true;
		}
	}
	return {
		branch,
		dirty,
		...(upstream ? { upstream } : {}),
		...(ahead !== undefined && behind !== undefined ? { ahead, behind } : {}),
	};
}

function nestedPaths(path: string, all: readonly string[]): string[] {
	const prefix = path ? `${path}/` : "";
	return all
		.filter((other) => other !== path && other.startsWith(prefix))
		.map((other) => other.slice(prefix.length));
}

async function repositoryStatus(
	project: Project,
	all: readonly string[],
): Promise<ProjectGroupRepositoryStatus> {
	const base = { projectId: project.id, path: project.projectGroup?.path ?? "" };
	const read = await gitAsync(
		project.path,
		["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
		{ timeoutMs: STATUS_TIMEOUT_MS },
	);
	if (!read.ok) return { ...base, branch: null, dirty: null };
	return { ...base, ...parseBranchStatus(read.out, nestedPaths(base.path, all)) };
}

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_REF = /^(?!-)[A-Za-z0-9._/-]+$/;

/**
 * An Issue worktree's changed paths and its branch's own upstream from one `status --porcelain=v2
 * --branch --untracked-files=all` read. Folders that are, or hold, `nested` (other worktrees of the
 * same Issue below this one, relative to it) are the Issue's layout, not a change.
 */
export function parseWorktreeStatus(
	out: string,
	nested: readonly string[] = [],
): { changedFiles: number; upstream?: string; upstreamAhead?: number; upstreamBehind?: number } {
	const { upstream, ahead, behind } = parseBranchStatus(out, nested);
	let changedFiles = 0;
	for (const line of out.split("\n")) {
		if (line === "" || line.startsWith("#")) continue;
		if (line.startsWith("? ") && line.endsWith("/")) {
			const folder = line.slice(2);
			if (nested.some((path) => `${path}/`.startsWith(folder))) continue;
		}
		changedFiles++;
	}
	return {
		changedFiles,
		...(upstream ? { upstream } : {}),
		...(ahead !== undefined && behind !== undefined
			? { upstreamAhead: ahead, upstreamBehind: behind }
			: {}),
	};
}

async function revCount(cwd: string, range: string): Promise<number | undefined> {
	const read = await gitAsync(cwd, ["rev-list", "--count", range, "--"], {
		timeoutMs: STATUS_TIMEOUT_MS,
	});
	if (!read.ok || !/^\d+$/.test(read.out)) return undefined;
	return Number(read.out);
}

/**
 * The default branch to measure an Issue branch against: `origin/HEAD`, else `origin/main` or
 * `origin/master`, else the main checkout's current branch (local), as of the last fetch.
 */
async function defaultBranchOf(cwd: string, mainBranch: string | null, issueBranch: string) {
	const head = await gitAsync(
		cwd,
		["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
		{
			timeoutMs: STATUS_TIMEOUT_MS,
		},
	);
	if (head.ok && SAFE_REF.test(head.out)) return head.out;
	for (const candidate of ["origin/main", "origin/master"]) {
		const found = await gitAsync(
			cwd,
			["rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}`],
			{
				timeoutMs: STATUS_TIMEOUT_MS,
			},
		);
		if (found.ok) return candidate;
	}
	return mainBranch && mainBranch !== issueBranch && SAFE_REF.test(mainBranch)
		? mainBranch
		: undefined;
}

async function isAncestor(cwd: string, oid: string): Promise<boolean> {
	return (
		await gitAsync(cwd, ["merge-base", "--is-ancestor", oid, "HEAD"], {
			timeoutMs: STATUS_TIMEOUT_MS,
		})
	).ok;
}

/**
 * The commit an Issue worktree started at. A joined repository records it at join; the primary does
 * not, so its branch's reflog creation entry (the oldest, written by `git worktree add -b`) stands in
 * while it is still an ancestor of HEAD, and failing that the merge-base with the default branch.
 */
export async function issueStartCommit(
	cwd: string,
	branch: string,
	recorded: string | undefined,
	defaultBranch: string | undefined,
): Promise<{ base: string; source: "recorded" | "created" | "mergeBase" } | undefined> {
	if (recorded && OID.test(recorded)) return { base: recorded, source: "recorded" };
	if (SAFE_REF.test(branch)) {
		const log = await gitAsync(cwd, ["reflog", "show", "--format=%H", `refs/heads/${branch}`], {
			timeoutMs: STATUS_TIMEOUT_MS,
		});
		const oldest = log.ok ? log.out.split("\n").filter(Boolean).at(-1) : undefined;
		if (oldest && OID.test(oldest) && (await isAncestor(cwd, oldest)))
			return { base: oldest, source: "created" };
	}
	if (defaultBranch) {
		const merged = await gitAsync(cwd, ["merge-base", "HEAD", defaultBranch], {
			timeoutMs: STATUS_TIMEOUT_MS,
		});
		if (merged.ok && OID.test(merged.out)) return { base: merged.out, source: "mergeBase" };
	}
	return undefined;
}

function relativeBelow(path: string, others: readonly string[]): string[] {
	const prefix = `${path}/`;
	return others
		.filter((other) => other.startsWith(prefix))
		.map((other) => other.slice(prefix.length));
}

async function issueRepository(
	repository: GroupIssueRecord["repositories"][number],
	context: {
		paths: ReadonlyMap<string, string>;
		mainBranches: ReadonlyMap<string, string | null>;
		worktrees: readonly string[];
		worktreePath: string | undefined;
		branch: string | undefined;
	},
): Promise<ProjectGroupIssueRepository> {
	const { base: recorded, ...rest } = repository;
	const path = context.paths.get(repository.projectId);
	const out: ProjectGroupIssueRepository = { ...rest, ...(path !== undefined ? { path } : {}) };
	const cwd = context.worktreePath;
	const branch = context.branch;
	if (!cwd || !branch) return out;
	out.branch = branch;
	const status = await gitAsync(
		cwd,
		["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all"],
		{ timeoutMs: STATUS_TIMEOUT_MS },
	);
	const worktree = status.ok
		? parseWorktreeStatus(status.out, relativeBelow(cwd, context.worktrees))
		: undefined;
	if (worktree) Object.assign(out, worktree);
	const defaultBranch = await defaultBranchOf(
		cwd,
		context.mainBranches.get(repository.projectId) ?? null,
		branch,
	);
	const start = await issueStartCommit(cwd, branch, recorded, defaultBranch);
	if (start) {
		out.baseSource = start.source;
		const ahead = await revCount(cwd, `${start.base}..HEAD`);
		if (ahead !== undefined) out.ahead = ahead;
	}
	if (defaultBranch) {
		const behind = await revCount(cwd, `HEAD..${defaultBranch}`);
		if (behind !== undefined) {
			out.behind = behind;
			out.defaultBranch = defaultBranch;
		}
	}
	if (out.ahead !== undefined && worktree) out.changed = out.ahead > 0 || worktree.changedFiles > 0;
	return out;
}

async function groupIssue(
	record: GroupIssueRecord,
	paths: ReadonlyMap<string, string>,
	mainBranches: ReadonlyMap<string, string | null>,
): Promise<ProjectGroupIssue> {
	const places = record.repositories.map((repository) => {
		if (!repository.workspaceId) return undefined;
		try {
			const ws = getWorkspace(repository.workspaceId);
			return { worktreePath: ws.worktreePath, branch: ws.branch };
		} catch {
			return undefined;
		}
	});
	const worktrees = places.flatMap((place) => (place ? [place.worktreePath] : []));
	return {
		provider: record.provider,
		instanceUrl: record.instanceUrl,
		number: record.number,
		...(record.title ? { title: record.title } : {}),
		projectId: record.projectId,
		repositories: await Promise.all(
			record.repositories.map((repository, index) =>
				issueRepository(repository, {
					paths,
					mainBranches,
					worktrees,
					worktreePath: places[index]?.worktreePath,
					branch: places[index]?.branch,
				}),
			),
		),
	};
}

/**
 * The group home's read: every open member's branch, dirtiness and upstream divergence (local
 * refs only, no network) plus the members' started Issue implementations.
 */
export async function projectGroupStatus(
	params: ProjectGroupTarget,
	issues: (projectIds: ReadonlySet<string>) => GroupIssueRecord[],
): Promise<ProjectGroupStatus> {
	const projects = members(params);
	const group = projects[0]?.projectGroup;
	if (!group) throw new Error(`Unknown project group: ${params.groupId}`);
	const ids = new Set(projects.map((project) => project.id));
	const paths = projects.map((project) => project.projectGroup?.path ?? "");
	let records: GroupIssueRecord[] = [];
	try {
		records = issues(ids);
	} catch {
		records = [];
	}
	const repositories = await mapBounded(projects, (project) => repositoryStatus(project, paths));
	const placeOf = new Map(
		projects.map((project) => [project.id, project.projectGroup?.path ?? ""]),
	);
	const mainBranches = new Map(repositories.map((row) => [row.projectId, row.branch]));
	const groupIssues = await mapBounded(records, (record) =>
		groupIssue(record, placeOf, mainBranches),
	);
	return { id: group.id, name: group.name, root: group.root, repositories, issues: groupIssues };
}

async function fetchRepository(project: Project): Promise<ProjectGroupFetchResult> {
	const base = { projectId: project.id, path: project.projectGroup?.path ?? "" };
	const remotes = await gitAsync(project.path, ["remote"], { timeoutMs: STATUS_TIMEOUT_MS });
	if (remotes.ok && remotes.out === "") return { ...base, outcome: "noRemote" };
	const fetched = await gitAsync(project.path, ["fetch", "--all", "--no-tags", "--quiet"], {
		network: true,
		timeoutMs: FETCH_TIMEOUT_MS,
	});
	if (fetched.ok) return { ...base, outcome: "fetched" };
	const error = (fetched.err || "git fetch failed")
		.replace(/\/\/[^\s/@]+@/g, "//***@")
		.trim()
		.slice(0, ERROR_MAX_LENGTH);
	return { ...base, outcome: "failed", error };
}

/** Best-effort `git fetch --all --no-tags` of every open member under the non-interactive env. */
export async function fetchProjectGroup(params: ProjectGroupTarget): Promise<ProjectGroupFetch> {
	return { results: await mapBounded(members(params), fetchRepository) };
}
