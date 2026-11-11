import type {
	Project,
	ProjectGroupFetch,
	ProjectGroupFetchResult,
	ProjectGroupIssue,
	ProjectGroupRepositoryStatus,
	ProjectGroupStatus,
	ProjectGroupTarget,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { gitAsync } from "../git";
import { projectGroupProjects } from "../projects";
import { getWorkspace } from "../workspaces";
import type { GroupIssueRecord } from "./issues";
import { worktreeUnchanged } from "./issuesActions";

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

async function issueChanged(workspaceId: string, start: string): Promise<boolean | undefined> {
	let path: string;
	try {
		path = getWorkspace(workspaceId).worktreePath;
	} catch {
		return undefined;
	}
	return !(await worktreeUnchanged(path, start));
}

async function groupIssue(record: GroupIssueRecord): Promise<ProjectGroupIssue> {
	return {
		provider: record.provider,
		instanceUrl: record.instanceUrl,
		number: record.number,
		projectId: record.projectId,
		repositories: await Promise.all(
			record.repositories.map(async ({ base, ...repository }) => {
				const changed =
					base && repository.workspaceId
						? await issueChanged(repository.workspaceId, base)
						: undefined;
				return changed === undefined ? repository : { ...repository, changed };
			}),
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
	const [repositories, groupIssues] = await Promise.all([
		mapBounded(projects, (project) => repositoryStatus(project, paths)),
		mapBounded(records, groupIssue),
	]);
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
