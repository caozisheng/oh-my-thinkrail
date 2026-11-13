import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	type IssueDesignPublicationInput,
	type IssueImplementationRecovery,
	type IssueImplementationRecoveryInput,
	type IssueImplementationTarget,
	type IssueReference,
	type IssueRepositories,
	type IssueRepositoriesCleanup,
	type IssueRepositoriesInput,
	type IssueRepositoryJoinInput,
	type IssueSessionLaunch,
	type IssueSessionStartupTarget,
	type IssueTarget,
	isIssueDesignPublicationInput,
	isIssueImplementationRecoveryInput,
	isIssueImplementationTarget,
	isIssueRepositoriesInput,
	isIssueRepositoryJoinInput,
	isIssueSessionStartupTarget,
	isIssueTarget,
	PROJECT_GROUP_MAX_REPOSITORIES,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { sessionReuseStatus } from "../agent";
import {
	gitAsync,
	listRemotes,
	nonInteractiveGitEnv,
	remoteNameOf,
	remoteRefOid,
	resolveCommitOid,
	resolveDefaultBranch,
} from "../git";
import {
	type ApprovalPublication,
	type ApprovalResult,
	createIssueWorkflow,
	createIssueWorkspaceCoordinator,
	type IssueRepositoryContext,
	type IssuesService,
	type IssueWorkspaceLayout,
	type WorkflowRemote,
	type WorkspaceHandle,
} from "../issues";
import { getProjects, projectGroupMembers } from "../projects";
import {
	createWorkspaceAtPathWithBranch,
	defaultWorkspaceOf,
	listGitWorktrees,
	listWorkspaceRecords,
	listWorkspaces,
	nestedWorkspaces,
	removeWorkspace,
	republishWorkspace,
} from "../workspaces";
import { createHostSession } from "./createHostSession";
import type { IssueAgentSessionHost } from "./issueAgentSessions";
import { createIssueWorkflowPersistence } from "./issueWorkflowPersistence";
import { createIssueWorkspacePersistence } from "./issueWorkspacePersistence";

type Action =
	| "addRepository"
	| "cleanupRepositories"
	| "designContexts"
	| "implementationContexts"
	| "implementationRecovery"
	| "recoverImplementation"
	| "repositories"
	| "setRepositories"
	| "beginDesign"
	| "beginImplementation"
	| "approveDesign"
	| "approveImplementation"
	| "launchDesign"
	| "launchImplementation"
	| "publishDesign"
	| "publishImplementation"
	| "startImplementation"
	| "validateDesign"
	| "validateImplementation";
function stop(): never {
	throw new CodedError(
		"RESOURCE_UNAVAILABLE",
		"Issue action is unavailable or requires reconciliation.",
	);
}
function invalid(): never {
	throw new CodedError("RANGE_INVALID", "Invalid Issue request.");
}
type ParsedAction =
	| { action: "setRepositories"; args: IssueRepositoriesInput }
	| { action: "recoverImplementation"; args: IssueImplementationRecoveryInput }
	| { action: "addRepository"; args: IssueRepositoryJoinInput }
	| { action: "beginDesign" | "beginImplementation"; args: IssueSessionStartupTarget }
	| {
			action:
				| "cleanupRepositories"
				| "designContexts"
				| "implementationContexts"
				| "repositories"
				| "approveDesign"
				| "approveImplementation"
				| "launchDesign"
				| "startImplementation"
				| "validateDesign"
				| "validateImplementation";
			args: IssueTarget;
	  }
	| {
			action: "launchImplementation" | "publishImplementation";
			args: IssueImplementationTarget;
	  }
	| { action: "publishDesign"; args: IssueDesignPublicationInput }
	| { action: "implementationRecovery"; args: IssueTarget };

function snapshot<T extends IssueTarget>(value: T): T {
	return { ...value, reference: { ...value.reference } };
}
function parse(value: unknown, action: Action): ParsedAction {
	switch (action) {
		case "recoverImplementation":
			if (!isIssueImplementationRecoveryInput(value)) invalid();
			return { action, args: structuredClone(value) };
		case "setRepositories":
			if (!isIssueRepositoriesInput(value)) invalid();
			return { action, args: { ...snapshot(value), projectIds: [...value.projectIds] } };
		case "addRepository":
			if (!isIssueRepositoryJoinInput(value)) invalid();
			return { action, args: snapshot(value) };
		case "beginDesign":
		case "beginImplementation":
			if (!isIssueSessionStartupTarget(value)) invalid();
			return { action, args: snapshot(value) };
		case "publishDesign":
			if (!isIssueDesignPublicationInput(value)) invalid();
			return { action, args: snapshot(value) };
		case "launchImplementation":
		case "publishImplementation":
			if (!isIssueImplementationTarget(value)) invalid();
			return { action, args: snapshot(value) };
		default:
			if (!isIssueTarget(value)) invalid();
			return { action, args: snapshot(value) };
	}
}
function trusted(projectId: string) {
	const project = getProjects().find((p) => p.id === projectId);
	if (project?.trusted !== true) stop();
	return project;
}
// Walk every existing ancestor: recursive mkdir must never traverse a symlink/junction.
export function privateDirectory(path: string): void {
	const parent = dirname(path);
	if (parent !== path) privateDirectory(parent);
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) stop();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		mkdirSync(path, { mode: 0o700 });
	}
}
/**
 * The trusted, open other members of the project's group: the repositories an Issue reads as
 * `reference` and may join on demand. Untrusted members are never offered (joining never grants trust).
 */
export function groupReferenceCandidates(projectId: string): string[] {
	return projectGroupMembers(projectId)
		.filter((project) => project.trusted === true)
		.slice(0, PROJECT_GROUP_MAX_REPOSITORIES)
		.map((project) => project.id);
}

/**
 * A layout only when every listed participant belongs to the primary's group and still sits at its
 * recorded place; it also places every other open member found where it belongs, so a later join can
 * use the same frozen slot. Null (ordinary per-repository paths) in every other case.
 */
export function groupWorkspaceLayout(
	primaryId: string,
	projectIds: readonly string[],
): IssueWorkspaceLayout | null {
	const projects = getProjects();
	const group = projects.find((project) => project.id === primaryId)?.projectGroup;
	if (!group) return null;
	let root: string;
	try {
		root = realpathSync.native(group.root);
	} catch {
		return null;
	}
	const place = (id: string): string | null => {
		const project = projects.find((candidate) => candidate.id === id);
		const membership = project?.projectGroup;
		if (!project || membership?.id !== group.id || membership.root !== group.root) return null;
		try {
			const actual = relative(root, realpathSync.native(project.path)).split(sep).join("/");
			return actual === membership.path ? actual : null;
		} catch {
			return null;
		}
	};
	const paths: IssueWorkspaceLayout["paths"] = [];
	for (const id of projectIds) {
		const path = place(id);
		if (path === null) return null;
		paths.push({ projectId: id, path });
	}
	for (const project of projects) {
		if (paths.length > PROJECT_GROUP_MAX_REPOSITORIES) break;
		if (project.closed || project.projectGroup?.id !== group.id || projectIds.includes(project.id))
			continue;
		const path = place(project.id);
		if (path !== null) paths.push({ projectId: project.id, path });
	}
	return { root, paths };
}

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Best-effort refresh of `origin`'s default branch, then that remote ref (e.g. `origin/main`) when it
 * exists; undefined (branch from local HEAD) without an origin, offline, or on any failure.
 */
export async function freshBaseRef(path: string): Promise<string | undefined> {
	const remotes = listRemotes(path);
	if (!remotes.includes("origin")) return undefined;
	const preferred = resolveDefaultBranch(path);
	const ref = remoteNameOf(preferred, remotes) ? preferred : `origin/${preferred}`;
	const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : undefined;
	const env = {
		...nonInteractiveGitEnv(),
		...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
	};
	await gitAsync(
		path,
		["fetch", "--no-tags", "origin", ...(branch && branch !== "HEAD" ? ["--", branch] : [])],
		{ network: true, timeoutMs: FETCH_TIMEOUT_MS, env },
	);
	return remoteRefOid(path, ref) ? ref : undefined;
}

/** No commit beyond `base` and a clean tree (tracked and untracked); ignored files do not count. */
export async function worktreeUnchanged(path: string, base: string): Promise<boolean> {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) return false;
	const ahead = await gitAsync(path, ["rev-list", "--count", `${base}..HEAD`, "--"]);
	if (!ahead.ok || ahead.out !== "0") return false;
	const status = await gitAsync(path, ["status", "--porcelain", "--untracked-files=all"]);
	return status.ok && status.out === "";
}

let archiveWorkspace: (workspaceId: string) => Promise<void> = removeWorkspace;
let waitForArchive: (path: string) => Promise<void> = async () => {};
export function setIssueArchiveBarrier(next: ((path: string) => Promise<void>) | null) {
	waitForArchive = next ?? (async () => {});
}
/** The host's full workspace-archive teardown (sessions, terminals, watchers) used by cleanup. */
export function setIssueWorkspaceArchiver(next: ((workspaceId: string) => Promise<void>) | null) {
	archiveWorkspace = next ?? removeWorkspace;
}

export type IssueActionSessions = {
	create?: typeof createHostSession;
	status?: typeof sessionReuseStatus;
};
export function createIssuesActions(
	service: () => Promise<IssuesService>,
	dir: string,
	sessions: IssueActionSessions = {},
	agentSessions?: IssueAgentSessionHost,
) {
	function run(
		action: "designContexts" | "implementationContexts",
		input: unknown,
	): Promise<IssueRepositoryContext[]>;
	function run(
		action: "repositories" | "setRepositories" | "addRepository",
		input: unknown,
	): Promise<IssueRepositories>;
	function run(action: "cleanupRepositories", input: unknown): Promise<IssueRepositoriesCleanup>;
	function run(
		action: "implementationRecovery",
		input: unknown,
	): Promise<IssueImplementationRecovery>;
	function run(action: "recoverImplementation", input: unknown): Promise<IssueSessionLaunch>;
	function run(
		action:
			| "beginDesign"
			| "beginImplementation"
			| "launchDesign"
			| "launchImplementation"
			| "startImplementation",
		input: unknown,
	): Promise<IssueSessionLaunch>;
	function run(
		action: "publishDesign" | "publishImplementation",
		input: unknown,
	): Promise<ApprovalPublication>;
	function run(
		action: "approveDesign" | "approveImplementation" | "validateDesign" | "validateImplementation",
		input: unknown,
	): Promise<ApprovalResult>;
	async function run(action: Action, input: unknown) {
		const request = parse(input, action);
		const { projectId, reference } = request.args;
		const initialProject = trusted(projectId);
		const issues = await service();
		if (trusted(projectId).path !== initialProject.path) stop();
		// Durable credentials restore lazily; actions must never require a manual reconnect first.
		await issues.restore(projectId);
		if (trusted(projectId).path !== initialProject.path) stop();
		const remote = issues.remoteFor(projectId, reference);
		// Design/implementation startup uses only the neutral read port. Resolve the GitLab-only
		// workflow capability only if a workflow operation actually needs it.
		const selectedProjects = new Map<string, string>();
		let pinned: WorkspaceHandle | undefined;
		let startupPrompt: string | undefined;
		const startup =
			request.action === "beginDesign" ||
			request.action === "beginImplementation" ||
			request.action === "recoverImplementation"
				? request.args
				: undefined;
		const stage =
			action === "launchDesign" || action === "beginDesign" ? "design" : "implementation";
		function guard() {
			for (const [id, path] of selectedProjects) {
				const member = trusted(id);
				if (member.closed || member.path !== path) stop();
			}
			if (
				trusted(projectId).path !== initialProject.path ||
				issues.remoteFor(projectId, reference) !== remote
			)
				stop();
			if (pinned) {
				const current = listWorkspaceRecords(projectId).find((ws) => ws.id === pinned?.id);
				if (
					!current ||
					current.worktreePath !== pinned.worktreePath ||
					current.branch !== pinned.branch ||
					current.kind !== pinned.kind
				)
					stop();
			}
		}
		async function checked<T>(operation: () => T | Promise<T>): Promise<T> {
			guard();
			try {
				return await operation();
			} finally {
				guard();
			}
		}
		const root = resolve(dir);
		guard();
		privateDirectory(root);
		const receiptDir = join(root, "issue-workflow");
		const workspaceDir = join(root, "issue-workspaces");
		privateDirectory(receiptDir);
		privateDirectory(workspaceDir);
		guard();
		const receipts = createIssueWorkflowPersistence(receiptDir);
		const launches = createIssueWorkspacePersistence(workspaceDir);
		guard();
		return launches.withLaunch(
			projectId,
			reference,
			async (ports) => {
				guard();
				const workflowRemote = (): ReturnType<typeof issues.workflowFor> =>
					issues.workflowFor(projectId, reference);
				const wrapped: WorkflowRemote = {
					issue: (...a) => checked(() => remote.issue(...a)),
					notes: (...a) => checked(() => remote.notes(...a)),
					labelEvents: (...a) => checked(() => workflowRemote().labelEvents(...a)),
					member: (...a) => checked(() => workflowRemote().member(...a)),
					currentUser: (...a) => checked(() => workflowRemote().currentUser(...a)),
					updateIssue: (...a) => checked(() => workflowRemote().updateIssue(...a)),
					addNote: (...a) => checked(() => remote.addNote(...a)),
				};
				const ownershipKey = JSON.stringify([
					projectId,
					reference.provider,
					reference.instanceUrl,
					reference.projectId,
					reference.number,
				]);
				const existingOwnership = await checked(() => ports.load(ownershipKey));
				const savedIds = existingOwnership?.repositoryProjectIds ?? [];
				const selectedIds =
					request.action === "setRepositories"
						? request.args.projectIds
						: request.action === "addRepository" &&
								!savedIds.includes(request.args.repositoryProjectId)
							? [...savedIds, request.args.repositoryProjectId]
							: savedIds;
				for (const id of selectedIds) {
					const member = trusted(id);
					if (member.closed) stop();
					selectedProjects.set(id, member.path);
				}
				function memberProject(id: string) {
					if (id === projectId) return trusted(id);
					const member = trusted(id);
					if (member.closed || selectedProjects.get(id) !== member.path) stop();
					return member;
				}
				function nameOf(context: Pick<IssueRepositoryContext, "projectId" | "role">): string {
					if (context.role !== "reference") return memberProject(context.projectId).name;
					return getProjects().find((p) => p.id === context.projectId)?.name ?? context.projectId;
				}
				function find(query: { workspaceId: string } | { worktreePath: string }) {
					return (
						[projectId, ...selectedProjects.keys()]
							.flatMap((id) => listWorkspaceRecords(id))
							.find((w) =>
								"workspaceId" in query
									? w.id === query.workspaceId
									: w.worktreePath === query.worktreePath,
							) ?? null
					);
				}
				async function currentCommit(ref: IssueReference) {
					const ws = await checked(() => coordinator.ownedImplementation(ref));
					if (
						pinned &&
						(ws.id !== pinned.id ||
							ws.worktreePath !== pinned.worktreePath ||
							ws.branch !== pinned.branch)
					)
						stop();
					pinned ??= { ...ws };
					const sha = await checked(() => resolveCommitOid(ws.worktreePath, "HEAD"));
					const after = await checked(() => coordinator.ownedImplementation(ref));
					if (
						after.id !== pinned.id ||
						after.worktreePath !== pinned.worktreePath ||
						after.branch !== pinned.branch ||
						!sha ||
						!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)
					)
						stop();
					return sha;
				}
				const workflow = createIssueWorkflow({
					clientFor: () => {
						guard();
						return wrapped;
					},
					persistence: {
						load: (ref) => checked(() => receipts.load(ref)),
						compareAndSet: (ref, revision, next) =>
							checked(() => receipts.compareAndSet(ref, revision, next)),
					},
					currentImplementationCommit: currentCommit,
				});
				let preparedPrompt: string | undefined;
				let sessionTitle: string | undefined;
				const coordinator = createIssueWorkspaceCoordinator({
					projectId,
					waitForArchive: (path) => checked(() => waitForArchive(path)),
					projectPath: (id) => checked(() => memberProject(id).path),
					load: (key) => checked(() => ports.load(key)),
					save: (key, row) => checked(() => ports.save(key, row)),
					findWorkspace: (query) => checked(() => find(query)),
					listGitWorktrees: (id) => checked(() => listGitWorktrees(id)),
					createWorkspaceAtPath: (id, path, branch, name, layoutRoot, baseRef) =>
						checked(() =>
							createWorkspaceAtPathWithBranch(
								id,
								path,
								branch,
								baseRef,
								name,
								layoutRoot === undefined ? {} : { layoutRoot },
							),
						),
					layout: (ids) => checked(() => groupWorkspaceLayout(projectId, ids)),
					baseRef: (id) => checked(() => freshBaseRef(memberProject(id).path)),
					headCommit: (path) => checked(() => resolveCommitOid(path, "HEAD")),
					recoveryBase: (id, branch) =>
						checked(async () => {
							const path = memberProject(id).path;
							const previousCommit = resolveCommitOid(path, `refs/heads/${branch}`);
							if (previousCommit)
								return { commit: previousCommit, source: "previous-branch" as const };
							const base = await freshBaseRef(path);
							const commit = resolveCommitOid(path, base ?? "HEAD");
							if (!commit) stop();
							return { commit, source: "restart" as const };
						}),
					references: () =>
						checked(() =>
							groupReferenceCandidates(projectId).flatMap((id) => {
								const project = getProjects().find((p) => p.id === id);
								const ws = defaultWorkspaceOf(id);
								return project && ws
									? [{ projectId: id, workspaceId: ws.id, path: project.path }]
									: [];
							}),
						),
					memberUnchanged: (ws, base) => checked(() => worktreeUnchanged(ws.worktreePath, base)),
					removeMember: (ws, base) =>
						checked(async () => {
							const project = memberProject(ws.projectId);
							if (
								nestedWorkspaces(ws.id).length > 0 ||
								!(await worktreeUnchanged(ws.worktreePath, base))
							)
								return false;
							await archiveWorkspace(ws.id);
							const tip = resolveCommitOid(project.path, `refs/heads/${ws.branch}`);
							// Delete only the reserved branch, and only while its tip is still inside the base.
							if (
								tip &&
								(await gitAsync(project.path, ["merge-base", "--is-ancestor", tip, base])).ok
							)
								await gitAsync(project.path, ["branch", "-D", ws.branch]);
							return true;
						}),
					boundSession: (stage, workspaceId) =>
						checked(async () => {
							if (!agentSessions) stop();
							const found = await checked(() =>
								agentSessions.findAssociation({ projectId, reference, stage, workspaceId }),
							);
							return found?.sessionId;
						}),
					defaultWorkspace: (id) =>
						checked(async () => {
							// Persistence-only read: resolving folder truth here would run synchronous git on
							// every session-context read (design launch, bound issue_context). The record's own
							// path/branch is what the coordinator verifies against the real project root.
							const recorded = listWorkspaceRecords(id).find((w) => w.kind === "default");
							if (recorded)
								return {
									id: recorded.id,
									projectId: recorded.projectId,
									worktreePath: recorded.worktreePath,
									branch: recorded.branch,
									kind: "default" as const,
								};
							const rows = await checked(() => listWorkspaces(id, { includeDiffStats: false }));
							const ws = rows.find((w) => w.projectId === id && w.kind === "default");
							if (!ws) stop();
							return ws;
						}),
					sessionExists: (id, workspaceId) =>
						checked(() => {
							const ws = find({ workspaceId });
							if (!ws) stop();
							return (sessions.status ?? sessionReuseStatus)(id, workspaceId, ws.worktreePath);
						}),
					createSession: (workspaceId) =>
						checked(async () => {
							if (!find({ workspaceId })) stop();
							// This port is called only after the coordinator decides a new session is needed.
							const title =
								sessionTitle ?? (await checked(() => wrapped.issue(reference.number))).title;
							const created = await checked(() =>
								(sessions.create ?? createHostSession)({ workspaceId }, guard, { title }),
							);
							if (startup) {
								if (!agentSessions || preparedPrompt === undefined) stop();
								await checked(() =>
									agentSessions.bind({
										sessionId: created.sessionId,
										workspaceId,
										projectId,
										reference,
										stage,
										locale: startup.locale,
									}),
								);
								// Only this newly created and durably bound session may start.
								startupPrompt = preparedPrompt;
							}
							return created.sessionId;
						}),
				});
				async function launch(kind: "design" | "implementation") {
					if (startup) {
						sessionTitle = (await checked(() => wrapped.issue(reference.number))).title;
						if (!agentSessions) stop();
						// Read all context before the coordinator can create a worktree or session.
						preparedPrompt = await checked(() =>
							agentSessions.prepare(
								{
									projectId,
									reference,
									stage,
									locale: startup.locale,
								},
								[],
							),
						);
					}
					const result = await checked(() =>
						kind === "design"
							? coordinator.design(reference)
							: request.action === "recoverImplementation"
								? coordinator.recoverImplementation(reference, request.args)
								: coordinator.implementation(reference),
					);
					if (kind === "implementation") {
						// The associated rows already reached clients through `workspace.created`, before
						// their ownership record existed; re-announce them so the rail tag converges.
						for (const member of await checked(() =>
							coordinator.contexts(reference, "implementation"),
						))
							if (member.role !== "reference") republishWorkspace(member.workspaceId);
					}
					if (startupPrompt !== undefined) {
						if (!agentSessions || !startup) stop();
						const repositories = await checked(() => coordinator.contexts(reference, kind));
						startupPrompt = await checked(() =>
							agentSessions.prepare(
								{ projectId, reference, stage, locale: startup.locale },
								repositories.map((repository) => ({ ...repository, name: nameOf(repository) })),
							),
						);
						await checked(() => agentSessions.start(result.sessionId, startupPrompt));
					}
					return result;
				}
				switch (request.action) {
					case "designContexts":
					case "implementationContexts": {
						const contexts = await coordinator.contexts(
							reference,
							request.action === "designContexts" ? "design" : "implementation",
						);
						return contexts.map((context) => ({ ...context, name: nameOf(context) }));
					}
					case "addRepository": {
						const result = await coordinator.addRepository(
							reference,
							request.args.repositoryProjectId,
						);
						if (result.locked)
							for (const member of await checked(() =>
								coordinator.contexts(reference, "implementation"),
							))
								if (member.projectId === request.args.repositoryProjectId)
									republishWorkspace(member.workspaceId);
						return result;
					}
					case "implementationRecovery":
						return coordinator.implementationRecovery(reference);
					case "recoverImplementation":
						return launch("implementation");
					case "cleanupRepositories":
						return coordinator.cleanupRepositories(reference);
					case "repositories":
						return coordinator.repositories(reference);
					case "setRepositories":
						return coordinator.setRepositories(reference, request.args.projectIds);
					case "approveDesign":
						return checked(() => workflow.approveStage(reference, "design"));
					case "approveImplementation":
						return checked(() => workflow.approveStage(reference, "implementation"));
					case "beginDesign":
					case "launchDesign":
						return launch("design");
					case "beginImplementation":
					case "launchImplementation":
					case "startImplementation":
						// No approval gate: an explicit click starts (or reuses) the Issue worktree.
						return launch("implementation");
					case "publishDesign":
						return checked(() =>
							workflow.publishDesign(
								reference,
								request.args.expectedDescription,
								request.args.newDescription,
							),
						);
					case "publishImplementation": {
						const sha = await currentCommit(reference);
						return checked(() =>
							workflow.publishImplementation(reference, request.args.approvedDesignVersion, sha),
						);
					}
					case "validateDesign":
						return checked(() => workflow.validateDesign(reference));
					case "validateImplementation":
						return checked(() => workflow.validateImplementation(reference));
				}
			},
			guard,
			[
				"addRepository",
				"implementationRecovery",
				"recoverImplementation",
				"repositories",
				"setRepositories",
				"beginDesign",
				"beginImplementation",
				"cleanupRepositories",
				"launchDesign",
				"launchImplementation",
				"startImplementation",
			].includes(action)
				? "release-on-settle"
				: "retain-on-failure",
		);
	}
	return {
		designContexts: (input: unknown) => run("designContexts", input),
		implementationContexts: (input: unknown) => run("implementationContexts", input),
		repositories: (input: unknown) => run("repositories", input),
		setRepositories: (input: unknown) => run("setRepositories", input),
		addRepository: (input: unknown) => run("addRepository", input),
		cleanupRepositories: (input: unknown) => run("cleanupRepositories", input),
		implementationRecovery: (input: unknown) => run("implementationRecovery", input),
		recoverImplementation: (input: unknown) => run("recoverImplementation", input),
		beginDesign: (input: unknown) => run("beginDesign", input),
		beginImplementation: (input: unknown) => run("beginImplementation", input),
		approveDesign: (input: unknown) => run("approveDesign", input),
		approveImplementation: (input: unknown) => run("approveImplementation", input),
		launchDesign: (input: unknown) => run("launchDesign", input),
		launchImplementation: (input: unknown) => run("launchImplementation", input),
		publishDesign: (input: unknown) => run("publishDesign", input),
		publishImplementation: (input: unknown) => run("publishImplementation", input),
		startImplementation: (input: unknown) => run("startImplementation", input),
		validateDesign: (input: unknown) => run("validateDesign", input),
		validateImplementation: (input: unknown) => run("validateImplementation", input),
	};
}
