import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type IssueReference,
	type IssueSessionLaunch,
	isIssueReference,
	isIssueRepositoriesInput,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";

export interface WorkspaceHandle {
	id: string;
	projectId: string;
	worktreePath: string;
	branch: string;
	/** Existing Workspace records omit kind for managed worktrees. */
	kind?: "default" | "external";
}

interface PendingWorkspace {
	state: "pending";
	worktreePath: string;
	branch: string;
}
interface CompletedWorkspace extends Omit<PendingWorkspace, "state"> {
	state: "completed";
	workspaceId: string;
	session?: { id: string };
}
/**
 * A project group's shared folder and each participating repository's `/`-separated place below it
 * (`""` is the root); frozen with the members so later group changes never move recorded paths.
 */
export interface IssueWorkspaceLayout {
	root: string;
	paths: { projectId: string; path: string }[];
}
export interface IssueWorkspaceRecord {
	projectId: string;
	reference: IssueReference;
	repositoryProjectIds?: string[];
	members?: { projectId: string; ownership?: PendingWorkspace | CompletedWorkspace }[];
	layout?: IssueWorkspaceLayout;
	/** Durable uncertainty fence; only provable reconciliation of the recorded stage may clear it. */
	sessionPending?: { stage: "design" | "implementation"; workspaceId: string };
	design?: { workspaceId: string; sessionId?: string };
	implementation?: PendingWorkspace | CompletedWorkspace;
}

type Awaitable<T> = T | Promise<T>;
export interface IssueWorkspaceOptions {
	/** Local project id, not the provider project id. */
	projectId: string;
	projectPath(projectId: string): Awaitable<string>;
	load(key: string): Awaitable<IssueWorkspaceRecord | null>;
	/** Atomic, durable per-key replacement. This coordinator serializes within one host process. */
	save(key: string, record: IssueWorkspaceRecord): Awaitable<void>;
	/** The host's fresh proof that this issue may start implementation: it already ran the workflow
	 * start gate, so the issue's current label is in-progress or in-review. Never caller input. */
	findWorkspace(
		query: { workspaceId: string } | { worktreePath: string },
	): Awaitable<WorkspaceHandle | null>;
	/** Authoritative Git registry, including occupied/detached/prunable paths; branch is short. */
	listGitWorktrees(
		projectId: string,
	): Awaitable<readonly { path: string; branch: string | null; prunable?: boolean }[]>;
	/** Register a managed workspace at exactly this path and branch, or fail without choosing a suffix. */
	createWorkspaceAtPath(
		projectId: string,
		path: string,
		branch: string,
		/** Human-readable workspace name; the branch stays the exact reserved ref. */
		name: string,
		/** The frozen layout root when the path mirrors a project group's layout. */
		layoutRoot?: string,
	): Awaitable<WorkspaceHandle>;
	/** The selection an Issue without a saved one starts from (its project group's other members). */
	defaultRepositoryProjectIds?: readonly string[];
	/** A shared layout for the primary plus selected projects, or null to keep per-repository paths. */
	layout?(projectIds: readonly string[]): Awaitable<IssueWorkspaceLayout | null>;
	defaultWorkspace(projectId: string): Awaitable<WorkspaceHandle>;
	/** Look up the session in this workspace; do not hydrate or prompt it. */
	sessionExists(sessionId: string, workspaceId: string): Awaitable<false | "idle" | "busy">;
	/** Create an empty session only. Prompting is outside this coordinator. */
	createSession(workspaceId: string): Awaitable<string>;
	/** The session this Issue already bound for that stage and workspace; the recovery evidence. */
	boundSession?(
		stage: "design" | "implementation",
		workspaceId: string,
	): Awaitable<string | undefined>;
}

// Different remote bindings can contend for the same numeric path in a local project.
const tails = new Map<string, Promise<unknown>>();

function stop(): never {
	throw new CodedError("RESOURCE_UNAVAILABLE", "Issue workspace requires reconciliation.");
}

function keyFor(projectId: string, ref: IssueReference): string {
	return JSON.stringify([projectId, ref.provider, ref.instanceUrl, ref.projectId, ref.number]);
}

function samePath(path: string, expected: string): boolean {
	return isAbsolute(path) && resolve(path) === expected;
}

async function directoryAt(path: string): Promise<boolean> {
	try {
		if (!(await lstat(path)).isDirectory()) stop();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function createIssueWorkspaceCoordinator(options: IssueWorkspaceOptions) {
	const { projectId } = options;

	async function run<T>(
		input: IssueReference,
		action: (key: string, record: IssueWorkspaceRecord) => Promise<T>,
		recover = false,
	): Promise<T> {
		if (!isIssueReference(input) || !projectId) stop();
		const reference = {
			provider: input.provider,
			instanceUrl: input.instanceUrl,
			projectId: input.projectId,
			number: input.number,
		};
		const key = keyFor(projectId, reference);
		const slot = JSON.stringify([projectId, reference.number]);
		const task = (tails.get(slot) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const record = (await options.load(key)) ?? { projectId, reference };
				if (
					!isIssueReference(record.reference) ||
					keyFor(record.projectId, record.reference) !== key
				)
					stop();
				return action(key, recover ? await recoverPending(key, record) : rejectPending(record));
			});
		tails.set(slot, task);
		try {
			return await task;
		} catch {
			return stop();
		} finally {
			if (tails.get(slot) === task) tails.delete(slot);
		}
	}

	function rejectPending(record: IssueWorkspaceRecord): IssueWorkspaceRecord {
		if (record.sessionPending !== undefined) stop();
		return record;
	}

	/**
	 * A pending marker records that a session may have been created. The binding the host writes
	 * immediately after creation is the only proof of which session it was: adopt it when it exists,
	 * otherwise nothing bound this stage and the marker is cleared so the action can try again.
	 */
	async function recoverPending(
		key: string,
		record: IssueWorkspaceRecord,
	): Promise<IssueWorkspaceRecord> {
		const pending = record.sessionPending;
		if (!pending) return record;
		if (!options.boundSession) stop();
		const sessionId = await options.boundSession(pending.stage, pending.workspaceId);
		const { sessionPending: _pending, ...recovered } = record;
		if (record.design) recovered.design = { ...record.design };
		if (record.implementation) recovered.implementation = { ...record.implementation };
		if (sessionId) {
			if (pending.stage === "design") {
				recovered.design = { workspaceId: pending.workspaceId, sessionId };
			} else {
				const implementation = recovered.implementation;
				if (
					implementation?.state !== "completed" ||
					implementation.workspaceId !== pending.workspaceId
				)
					stop();
				recovered.implementation = { ...implementation, session: { id: sessionId } };
			}
		}
		await options.save(key, recovered);
		return recovered;
	}

	function selection(record: IssueWorkspaceRecord): string[] {
		if (record.repositoryProjectIds) return [...record.repositoryProjectIds];
		if (record.implementation || record.members) return [];
		return [...(options.defaultRepositoryProjectIds ?? [])];
	}

	function segments(path: string): string[] {
		return path.split("/").filter(Boolean);
	}

	/** Where the Issue's checkout of `id` lives: the group layout when frozen, else per repository. */
	async function worktreePathFor(record: IssueWorkspaceRecord, id: string): Promise<string> {
		const number = record.reference.number;
		const suffix = createHash("sha256")
			.update(keyFor(projectId, record.reference))
			.digest("hex")
			.slice(0, 16);
		if (record.layout) {
			const place = (id: string) =>
				record.layout?.paths.find((entry) => entry.projectId === id)?.path;
			const own = place(id);
			const primary = place(projectId);
			if (own === undefined || primary === undefined) stop();
			const slot = primary === "" ? `issue-${number}` : `issue-${number}-${suffix}`;
			const root = record.layout.root;
			if (!isAbsolute(root)) stop();
			return join(await realpath(root), ".worktrees", slot, ...segments(own));
		}
		const name = id === projectId ? `issue-${number}` : `issue-${number}-${suffix}`;
		return join(await projectRoot(id), ".worktrees", name);
	}

	/** Without a layout, members first then the primary; with one, shallow folders before nested ones. */
	function creationOrder(record: IssueWorkspaceRecord): string[] {
		const ids = [...(record.members ?? []).map((member) => member.projectId), projectId];
		const layout = record.layout;
		if (!layout) return ids;
		const depth = (id: string) =>
			segments(layout.paths.find((entry) => entry.projectId === id)?.path ?? "").length;
		return ids.sort((a, b) => depth(a) - depth(b));
	}

	async function projectRoot(memberProjectId = projectId): Promise<string> {
		const path = await options.projectPath(memberProjectId);
		if (!isAbsolute(path)) stop();
		return realpath(path);
	}

	async function sessionStatus(workspaceId: string, sessionId?: string) {
		const status = sessionId ? await options.sessionExists(sessionId, workspaceId) : false;
		if (status === "busy") stop();
		return status;
	}

	async function newSession(workspaceId: string): Promise<string> {
		const sessionId = await options.createSession(workspaceId);
		if (!sessionId) stop();
		return sessionId;
	}

	async function implementationPathState(path: string, memberProjectId = projectId) {
		await directoryAt(dirname(path)); // Refuse a symlink/junction before inspecting its child.
		const occupied = await directoryAt(path);
		const trees = (await options.listGitWorktrees(memberProjectId)).filter((tree) =>
			samePath(tree.path, path),
		);
		return { occupied, trees };
	}

	function verifyWorkspace(
		ws: WorkspaceHandle | null,
		ownership: PendingWorkspace | CompletedWorkspace,
		path: string,
		memberProjectId = projectId,
	): WorkspaceHandle {
		if (
			!ws?.id ||
			ws.projectId !== memberProjectId ||
			ws.kind !== undefined ||
			!samePath(ws.worktreePath, path) ||
			ws.branch !== ownership.branch ||
			(ownership.state === "completed" && ws.id !== ownership.workspaceId)
		)
			stop();
		return ws;
	}

	async function verifyImplementation(
		ownership: PendingWorkspace | CompletedWorkspace,
		path: string,
		memberProjectId = projectId,
	): Promise<WorkspaceHandle> {
		const { occupied, trees } = await implementationPathState(path, memberProjectId);
		if (
			ownership.worktreePath !== path ||
			!ownership.branch ||
			!occupied ||
			trees.length !== 1 ||
			trees[0]?.branch !== ownership.branch ||
			trees[0].prunable
		)
			stop();
		const ws = await options.findWorkspace(
			ownership.state === "completed"
				? { workspaceId: ownership.workspaceId }
				: { worktreePath: path },
		);
		return verifyWorkspace(ws, ownership, path, memberProjectId);
	}

	async function resolveImplementation(key: string, record: IssueWorkspaceRecord, path: string) {
		let ownership = record.implementation;
		let ws: WorkspaceHandle;
		if (ownership?.state === "pending") {
			const { occupied, trees } = await implementationPathState(path);
			const registered = await options.findWorkspace({ worktreePath: path });
			// An abandoned reservation that left no directory, Git entry or registration created nothing.
			if (!occupied && trees.length === 0 && !registered) ownership = undefined;
		}
		if (ownership) {
			ws = await verifyImplementation(ownership, path);
		} else {
			const { occupied, trees } = await implementationPathState(path);
			if (occupied || trees.length || (await options.findWorkspace({ worktreePath: path }))) stop();
			// The unpredictable reserved ref correlates a registered worktree with this create intent;
			// a user checkout at the same numeric path is not ownership evidence.
			ownership = {
				state: "pending",
				worktreePath: path,
				branch: `issue-${record.reference.number}-${randomUUID()}`,
			};
			await options.save(key, { ...record, implementation: ownership });
			ws = verifyWorkspace(
				await options.createWorkspaceAtPath(
					projectId,
					path,
					ownership.branch,
					`issue-${record.reference.number}`,
					record.layout?.root,
				),
				ownership,
				path,
			);
		}
		if (ownership.state === "completed") return ownership;
		const completed: CompletedWorkspace = { ...ownership, state: "completed", workspaceId: ws.id };
		await options.save(key, { ...record, implementation: completed });
		return completed;
	}

	async function freezeMembers(key: string, record: IssueWorkspaceRecord) {
		const selected = selection(record);
		if (!selected.length && !record.members) return record;
		if (!record.members) {
			if (record.implementation) stop();
			const layout = options.layout ? await options.layout([projectId, ...selected]) : null;
			record = {
				...record,
				repositoryProjectIds: selected,
				members: selected.map((projectId) => ({ projectId })),
				...(layout ? { layout } : {}),
			};
			await options.save(key, record);
		}
		if (record.members?.map((member) => member.projectId).join("\n") !== selected.join("\n"))
			stop();
		return record;
	}

	async function prepareMember(key: string, record: IssueWorkspaceRecord, memberProjectId: string) {
		const member = record.members?.find((candidate) => candidate.projectId === memberProjectId);
		if (!member) stop();
		const path = await worktreePathFor(record, member.projectId);
		let ownership = member.ownership;
		const state = await implementationPathState(path, member.projectId);
		const registered = await options.findWorkspace({ worktreePath: path });
		if (ownership?.state === "pending" && !state.occupied && !state.trees.length && !registered)
			ownership = undefined;
		if (ownership) {
			const ws = await verifyImplementation(ownership, path, member.projectId);
			member.ownership = { ...ownership, state: "completed", workspaceId: ws.id };
		} else {
			if (state.occupied || state.trees.length || registered) stop();
			ownership = {
				state: "pending",
				worktreePath: path,
				branch: `issue-${record.reference.number}-${randomUUID()}`,
			};
			member.ownership = ownership;
			await options.save(key, record);
			const ws = verifyWorkspace(
				await options.createWorkspaceAtPath(
					member.projectId,
					path,
					ownership.branch,
					`issue-${record.reference.number}`,
					record.layout?.root,
				),
				ownership,
				path,
				member.projectId,
			);
			member.ownership = { ...ownership, state: "completed", workspaceId: ws.id };
		}
		await options.save(key, record);
	}

	return {
		contexts(reference: IssueReference, stage: "design" | "implementation") {
			return run(reference, async (_key, record) => {
				const ids = [projectId, ...selection(record)];
				return Promise.all(
					ids.map(async (id) => {
						let ws: WorkspaceHandle;
						if (stage === "design") {
							ws = await options.defaultWorkspace(id);
							if (
								ws.projectId !== id ||
								ws.kind !== "default" ||
								!samePath(ws.worktreePath, await projectRoot(id))
							)
								stop();
						} else {
							const ownership =
								id === projectId
									? record.implementation
									: record.members?.find((member) => member.projectId === id)?.ownership;
							if (ownership?.state !== "completed") stop();
							ws = await verifyImplementation(ownership, await worktreePathFor(record, id), id);
						}
						return {
							projectId: id,
							workspaceId: ws.id,
							path: ws.worktreePath,
							role: id === projectId ? ("primary" as const) : ("associated" as const),
						};
					}),
				);
			});
		},
		repositories(reference: IssueReference) {
			return run(reference, async (_key, record) => ({
				projectIds: selection(record),
				locked: record.implementation !== undefined || record.members !== undefined,
			}));
		},
		setRepositories(reference: IssueReference, projectIds: string[]) {
			return run(reference, async (key, record) => {
				if (
					record.implementation ||
					record.members ||
					!isIssueRepositoriesInput({ projectId, reference, projectIds })
				)
					stop();
				await options.save(key, { ...record, repositoryProjectIds: [...projectIds] });
				return { projectIds: [...projectIds], locked: false };
			});
		},
		ownedImplementation(reference: IssueReference): Promise<WorkspaceHandle> {
			return run(reference, async (_key, record) => {
				const ownership = record.implementation;
				if (ownership?.state !== "completed" || !ownership.workspaceId) stop();
				return verifyImplementation(ownership, await worktreePathFor(record, projectId));
			});
		},
		design(reference: IssueReference): Promise<IssueSessionLaunch> {
			return run(
				reference,
				async (key, record) => {
					const root = await projectRoot();
					const ws = await options.defaultWorkspace(projectId);
					if (
						!ws.id ||
						ws.projectId !== projectId ||
						ws.kind !== "default" ||
						!samePath(ws.worktreePath, root)
					)
						stop();
					const workspaceId = ws.id;
					const existing =
						record.design?.workspaceId === workspaceId ? record.design.sessionId : undefined;
					if (existing && (await sessionStatus(workspaceId, existing)) === "idle")
						return { workspaceId, sessionId: existing };
					await options.save(key, {
						...record,
						design: { workspaceId, ...(existing ? { sessionId: existing } : {}) },
						sessionPending: { stage: "design", workspaceId },
					});
					const sessionId = await newSession(workspaceId);
					await options.save(key, { ...record, design: { workspaceId, sessionId } });
					return { workspaceId, sessionId };
				},
				true,
			);
		},
		implementation(reference: IssueReference): Promise<IssueSessionLaunch> {
			return run(
				reference,
				async (key, record) => {
					record = await freezeMembers(key, record);
					let primary: CompletedWorkspace | undefined;
					for (const id of creationOrder(record)) {
						if (id !== projectId) {
							await prepareMember(key, record, id);
							continue;
						}
						primary = await resolveImplementation(
							key,
							record,
							await worktreePathFor(record, projectId),
						);
						record = { ...record, implementation: primary };
					}
					if (!primary) stop();
					const ownership = primary;
					const { workspaceId, session } = ownership;
					const status = await sessionStatus(workspaceId, session?.id);
					if (session && status === "idle") return { workspaceId, sessionId: session.id };
					await options.save(key, {
						...record,
						implementation: ownership,
						sessionPending: { stage: "implementation", workspaceId },
					});
					const sessionId = await newSession(workspaceId);
					await options.save(key, {
						...record,
						implementation: { ...ownership, session: { id: sessionId } },
					});
					return { workspaceId, sessionId };
				},
				true,
			);
		},
	};
}
