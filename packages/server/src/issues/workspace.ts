import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
	type IssueImplementationRecovery,
	type IssueImplementationRecoveryInput,
	type IssueReference,
	type IssueSessionLaunch,
	isIssueImplementationRecoveryInput,
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
	kind?: "default" | "external" | "chat";
}

interface PendingWorkspace {
	state: "pending";
	worktreePath: string;
	branch: string;
	recoveryCommit?: string;
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
	/**
	 * The `<root>/.worktrees/<slot>` folder name, frozen with the layout: `issue-<n>-<digest16>` for
	 * every Issue, whichever member is primary. Absent only on records frozen before it existed, which
	 * keep their original name (`issue-<n>` when the primary sat at the group folder itself).
	 */
	slot?: string;
}
/** One repository joined to an Issue's implementation besides the primary. */
export interface IssueWorkspaceMember {
	projectId: string;
	ownership?: PendingWorkspace | CompletedWorkspace;
	/** The commit the worktree started at; only a member created with it recorded can be cleaned up. */
	base?: string;
	/** Durable removal intent for an unchanged member; settling it finishes or reverts the removal. */
	removing?: true;
}
export interface IssueImplementationHistory {
	workspaceId: string;
	worktreePath: string;
	branch: string;
	sessionId?: string;
	archivedAt: number;
}
export interface IssueWorkspaceRecord {
	projectId: string;
	reference: IssueReference;
	repositoryProjectIds?: string[];
	members?: IssueWorkspaceMember[];
	layout?: IssueWorkspaceLayout;
	/** Durable uncertainty fence; only provable reconciliation of the recorded stage may clear it. */
	sessionPending?: { stage: "design" | "implementation"; workspaceId: string };
	design?: { workspaceId: string; sessionId?: string };
	implementation?: PendingWorkspace | CompletedWorkspace;
	/** Prior completed implementation generations; transcript ownership remains with pi. */
	implementationHistory?: IssueImplementationHistory[];
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
		/** The ref to branch from (e.g. `origin/main`); absent keeps the repository's local HEAD. */
		baseRef?: string,
	): Awaitable<WorkspaceHandle>;
	/**
	 * A shared layout covering at least the primary plus `projectIds` (it may place further group
	 * members, which can join later), or null to keep per-repository paths.
	 */
	layout?(projectIds: readonly string[]): Awaitable<IssueWorkspaceLayout | null>;
	/** Best-effort freshly fetched base ref for a new member worktree, or undefined for local HEAD. */
	baseRef?(projectId: string): Awaitable<string | undefined>;
	/** The commit checked out at a just-created worktree. */
	headCommit?(path: string): Awaitable<string | null>;
	/** Other repositories an Issue may read (as `reference`) and join: their main checkouts. */
	references?(): Awaitable<readonly { projectId: string; workspaceId: string; path: string }[]>;
	/** True only when the worktree has no commits beyond `base` and no tracked or untracked change. */
	memberUnchanged?(ws: WorkspaceHandle, base: string): Awaitable<boolean>;
	/** Re-check unchanged, then archive the workspace and delete its branch; false keeps it. */
	removeMember?(ws: WorkspaceHandle, base: string): Awaitable<boolean>;
	defaultWorkspace(projectId: string): Awaitable<WorkspaceHandle>;
	/** Look up the session in this workspace; do not hydrate or prompt it. */
	sessionExists(sessionId: string, workspaceId: string): Awaitable<false | "idle" | "busy">;
	/** Create an empty session only. Prompting is outside this coordinator. */
	createSession(workspaceId: string): Awaitable<string>;
	recoveryBase?(
		projectId: string,
		branch: string,
	): Awaitable<{ commit: string; source: "previous-branch" | "restart" }>;
	waitForArchive?(path: string): Awaitable<void>;
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

/** A clear, expected refusal that leaves the record untouched; it passes through unchanged. */
function refuse(message: string): never {
	throw new CodedError("ISSUE_REPOSITORY_REFUSED", message);
}
const MAX_MEMBERS = 32;

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
		allowPending = false,
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
				return action(
					key,
					recover
						? await recoverPending(key, record)
						: allowPending
							? record
							: rejectPending(record),
				);
			});
		tails.set(slot, task);
		try {
			return await task;
		} catch (error) {
			if (error instanceof CodedError && error.code === "ISSUE_REPOSITORY_REFUSED") throw error;
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

	/** Before preparation the saved pre-selection; afterwards the joined members not being removed. */
	function selection(record: IssueWorkspaceRecord): string[] {
		if (record.members)
			return record.members.filter((member) => !member.removing).map((member) => member.projectId);
		return [...(record.repositoryProjectIds ?? [])];
	}

	function locked(record: IssueWorkspaceRecord): boolean {
		return record.implementation !== undefined || record.members !== undefined;
	}

	function segments(path: string): string[] {
		return path.split(/[\\/]/).filter(Boolean);
	}

	function digest(record: IssueWorkspaceRecord): string {
		return createHash("sha256")
			.update(keyFor(projectId, record.reference))
			.digest("hex")
			.slice(0, 16);
	}

	/** The uniform slot name of a newly frozen layout: no member (not even the group folder) is special. */
	function slotName(record: IssueWorkspaceRecord): string {
		return `issue-${record.reference.number}-${digest(record)}`;
	}

	/** The group slot `<root>/.worktrees/<slot>` every layout-placed checkout of this Issue lives in. */
	async function slotFor(record: IssueWorkspaceRecord): Promise<string> {
		const primary = placeOf(record, projectId);
		const root = record.layout?.root;
		if (primary === undefined || root === undefined || !isAbsolute(root)) stop();
		// A record frozen before slots were stored keeps the name it was created with.
		const legacy = primary === "" ? `issue-${record.reference.number}` : slotName(record);
		return join(await realpath(root), ".worktrees", record.layout?.slot ?? legacy);
	}

	/** Where the Issue's checkout of `id` lives: the group layout when frozen, else per repository. */
	async function worktreePathFor(record: IssueWorkspaceRecord, id: string): Promise<string> {
		const own = placeOf(record, id);
		if (record.layout && (own !== undefined || id === projectId)) {
			if (own === undefined) stop();
			return join(await slotFor(record), ...segments(own));
		}
		const number = record.reference.number;
		const name = id === projectId ? `issue-${number}` : `issue-${number}-${digest(record)}`;
		return join(await projectRoot(id), ".worktrees", name);
	}

	/** A repository's frozen place in the layout; a later-joined non-group project has none. */
	function placeOf(record: IssueWorkspaceRecord, id: string): string | undefined {
		return record.layout?.paths.find((entry) => entry.projectId === id)?.path;
	}

	/** Without a layout, members first then the primary; with one, shallow folders before nested ones. */
	function creationOrder(record: IssueWorkspaceRecord): string[] {
		const ids = [
			...(record.members ?? []).filter((member) => !member.removing).map((m) => m.projectId),
			projectId,
		];
		if (!record.layout) return ids;
		const depth = (id: string) => segments(placeOf(record, id) ?? "").length;
		return ids.sort((a, b) => depth(a) - depth(b));
	}

	/** The fresh base for a new worktree: always for members, for the primary only in a group layout. */
	async function baseFor(record: IssueWorkspaceRecord, id: string): Promise<string | undefined> {
		if (id === projectId && !record.layout) return undefined;
		try {
			return (await options.baseRef?.(id)) || undefined;
		} catch {
			return undefined;
		}
	}

	async function projectRoot(memberProjectId = projectId): Promise<string> {
		const path = await options.projectPath(memberProjectId);
		if (!isAbsolute(path)) stop();
		return realpath(path);
	}

	async function sessionStatus(workspaceId: string, sessionId?: string) {
		return sessionId ? options.sessionExists(sessionId, workspaceId) : false;
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
		const state = await implementationPathState(path);
		const registered = await options.findWorkspace({ worktreePath: path });
		// An abandoned reservation that left no directory, Git entry or registration created nothing.
		if (
			ownership?.state === "pending" &&
			!state.occupied &&
			state.trees.length === 0 &&
			!registered &&
			!ownership.recoveryCommit
		)
			ownership = undefined;
		const retryRecovery =
			ownership?.state === "pending" &&
			ownership.recoveryCommit &&
			!state.occupied &&
			!state.trees.length &&
			!registered;
		if (ownership && !retryRecovery) {
			ws = await verifyImplementation(ownership, path);
		} else {
			const { occupied, trees } = await implementationPathState(path);
			if (occupied || trees.length || (await options.findWorkspace({ worktreePath: path }))) stop();
			// The unpredictable reserved ref correlates a registered worktree with this create intent;
			// a user checkout at the same numeric path is not ownership evidence.
			ownership = ownership ?? {
				state: "pending",
				worktreePath: path,
				branch: `issue-${record.reference.number}-${randomUUID()}`,
			};
			await options.save(key, { ...record, implementation: ownership });
			const base = ownership.recoveryCommit ?? (await baseFor(record, projectId));
			ws = verifyWorkspace(
				await options.createWorkspaceAtPath(
					projectId,
					path,
					ownership.branch,
					`issue-${record.reference.number}`,
					record.layout?.root,
					base,
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
		// Primary-only ownership (no members) stays as it was; joining adds members later.
		if (!selected.length && !record.members && record.implementation) return record;
		if (!record.members) {
			if (record.implementation) stop();
			const layout = options.layout ? await options.layout([projectId, ...selected]) : null;
			// A single repository with nothing selected keeps its exact pre-group record shape.
			if (!selected.length && !layout) return record;
			record = {
				...record,
				repositoryProjectIds: selected,
				members: selected.map((projectId) => ({ projectId })),
				...(layout ? { layout: { ...layout, slot: slotName(record) } } : {}),
			};
			await options.save(key, record);
		}
		if (
			record.members?.map((member) => member.projectId).join("\n") !==
			(record.repositoryProjectIds ?? []).join("\n")
		)
			stop();
		return record;
	}

	async function prepareMember(key: string, record: IssueWorkspaceRecord, memberProjectId: string) {
		const member = record.members?.find((candidate) => candidate.projectId === memberProjectId);
		if (!member || member.removing) stop();
		const path = await worktreePathFor(record, member.projectId);
		let ownership = member.ownership;
		const state = await implementationPathState(path, member.projectId);
		const registered = await options.findWorkspace({ worktreePath: path });
		if (ownership?.state === "pending" && !state.occupied && !state.trees.length && !registered)
			ownership = ownership.recoveryCommit ? ownership : undefined;
		if (
			ownership &&
			!(
				ownership.state === "pending" &&
				ownership.recoveryCommit &&
				!state.occupied &&
				!state.trees.length &&
				!registered
			)
		) {
			const ws = await verifyImplementation(ownership, path, member.projectId);
			member.ownership = { ...ownership, state: "completed", workspaceId: ws.id };
		} else {
			if (state.occupied || state.trees.length || registered) stop();
			ownership = ownership ?? {
				state: "pending",
				worktreePath: path,
				branch: `issue-${record.reference.number}-${randomUUID()}`,
			};
			member.ownership = ownership;
			await options.save(key, record);
			const base = ownership.recoveryCommit ?? (await baseFor(record, member.projectId));
			const ws = verifyWorkspace(
				await options.createWorkspaceAtPath(
					member.projectId,
					path,
					ownership.branch,
					`issue-${record.reference.number}`,
					placeOf(record, member.projectId) === undefined ? undefined : record.layout?.root,
					base,
				),
				ownership,
				path,
				member.projectId,
			);
			member.ownership = { ...ownership, state: "completed", workspaceId: ws.id };
			const head = await options.headCommit?.(ws.worktreePath);
			if (head && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) member.base = head;
		}
		await options.save(key, record);
	}

	function inside(path: string, outer: string): boolean {
		return path.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
	}

	/** The Issue's joined checkouts (primary first) with their recorded worktree paths. */
	async function joinedPaths(record: IssueWorkspaceRecord) {
		const rows: { projectId: string; path: string }[] = [];
		for (const id of [projectId, ...selection(record)])
			rows.push({ projectId: id, path: await worktreePathFor(record, id) });
		return rows;
	}

	/** Finish or revert a recorded removal: a member that changed since cleanup chose it stays. */
	async function settleRemovals(key: string, record: IssueWorkspaceRecord) {
		for (const member of [...(record.members ?? [])]) {
			if (!member.removing) continue;
			const ownership = member.ownership;
			const path = await worktreePathFor(record, member.projectId);
			const ws = await options.findWorkspace({ worktreePath: path });
			let removed = !ws;
			if (ws) {
				if (ownership?.state !== "completed" || !member.base || !options.removeMember) stop();
				removed = await options.removeMember(
					verifyWorkspace(ws, ownership, path, member.projectId),
					member.base,
				);
			}
			if (removed) {
				await pruneEmptyParents(record, path);
				record.members = (record.members ?? []).filter((m) => m !== member);
				record.repositoryProjectIds = (record.repositoryProjectIds ?? []).filter(
					(id) => id !== member.projectId,
				);
			} else delete member.removing;
			await options.save(key, record);
		}
		return record;
	}

	/** Drop the empty folders a removed nested checkout leaves inside the group slot. */
	async function pruneEmptyParents(record: IssueWorkspaceRecord, path: string) {
		if (!record.layout) return;
		const slot = await slotFor(record);
		const kept = new Set((await joinedPaths(record)).map((row) => row.path));
		for (let dir = dirname(path); inside(dir, slot) && !kept.has(dir); dir = dirname(dir)) {
			try {
				await rmdir(dir);
			} catch {
				return;
			}
		}
	}

	/** An empty folder left at a member's place (by an earlier nested checkout) is not ownership. */
	async function clearEmptyPlace(path: string) {
		try {
			if ((await lstat(path)).isDirectory() && (await readdir(path)).length === 0)
				await rmdir(path);
		} catch {}
	}

	async function exists(path: string): Promise<boolean> {
		try {
			await lstat(path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/** Reserve a new member's place, refusing one that would swallow or collide with a joined checkout. */
	async function admitMember(key: string, record: IssueWorkspaceRecord, memberId: string) {
		const members = record.members ?? [];
		if (members.length >= MAX_MEMBERS)
			refuse(`An Issue can join at most ${MAX_MEMBERS} repositories besides its own.`);
		if (record.layout && placeOf(record, memberId) === undefined && options.layout) {
			// A group member imported after the layout froze: extend it additively, never moving a place.
			const fresh = await options.layout([projectId, ...selection(record), memberId]);
			const entry = fresh?.paths.find((candidate) => candidate.projectId === memberId);
			if (fresh && entry && fresh.root === record.layout.root)
				record.layout = { ...record.layout, paths: [...record.layout.paths, { ...entry }] };
		}
		const target = await worktreePathFor(record, memberId);
		const describe = (id: string) => {
			const place = placeOf(record, id);
			return place === undefined ? id : place === "" ? "/" : place;
		};
		for (const other of await joinedPaths(record)) {
			if (other.path === target || inside(other.path, target))
				refuse(
					`Cannot join ${describe(memberId)}: the joined repository ${describe(other.projectId)} already lives inside its folder in this Issue's worktree. Join outer repositories before the ones nested in them.`,
				);
		}
		await clearEmptyPlace(target);
		if (await exists(target))
			refuse(
				`Cannot join ${describe(memberId)}: ${target} already exists (a joined repository tracks that path).`,
			);
		record.members = [...members, { projectId: memberId }];
		record.repositoryProjectIds = [...(record.repositoryProjectIds ?? []), memberId];
		await options.save(key, record);
	}

	async function prepareImplementation(
		key: string,
		record: IssueWorkspaceRecord,
	): Promise<IssueSessionLaunch> {
		record = await freezeMembers(key, record);
		record = await settleRemovals(key, record);
		let primary: CompletedWorkspace | undefined;
		for (const id of creationOrder(record)) {
			if (id !== projectId) {
				await prepareMember(key, record, id);
				continue;
			}
			primary = await resolveImplementation(key, record, await worktreePathFor(record, projectId));
			record = { ...record, implementation: primary };
		}
		if (!primary) stop();
		const ownership = primary;
		const { workspaceId, session } = ownership;
		const status = await sessionStatus(workspaceId, session?.id);
		if (session && status) return { workspaceId, sessionId: session.id };
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
	}

	async function diagnoseRecovery(
		record: IssueWorkspaceRecord,
	): Promise<IssueImplementationRecovery> {
		const generation = record.implementationHistory?.length ?? 0;
		const members: IssueImplementationRecovery["members"] = [];
		let reason: IssueImplementationRecovery["reason"] = null;
		let requiresRestart = false;
		if (record.sessionPending || record.members?.some((row) => row.removing))
			reason = "pending-operation";
		if (!record.implementation) reason = "missing-record";
		for (const id of [projectId, ...selection(record)]) {
			if (reason) break;
			const ownership =
				id === projectId
					? record.implementation
					: record.members?.find((row) => row.projectId === id)?.ownership;
			if (ownership?.state !== "completed") {
				reason = "pending-operation";
				break;
			}
			const path = await worktreePathFor(record, id);
			if (path !== ownership.worktreePath) stop();
			await options.waitForArchive?.(path);
			const state = await implementationPathState(path, id);
			const byId = await options.findWorkspace({ workspaceId: ownership.workspaceId });
			const byPath = await options.findWorkspace({ worktreePath: path });
			const missing = !state.occupied && state.trees.length === 0 && !byId && !byPath;
			if (!missing) {
				try {
					await verifyImplementation(ownership, path, id);
					continue;
				} catch {
					reason = "resources-remain";
					break;
				}
			}
			if (!options.recoveryBase) stop();
			const base = await options.recoveryBase(id, ownership.branch);
			if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base.commit)) stop();
			requiresRestart ||= base.source === "restart";
			members.push({
				projectId: id,
				worktreePath: path,
				branch: ownership.branch,
				baseCommit: base.commit,
			});
		}
		if (!reason && !members.length) reason = "resources-remain";
		const snapshot = createHash("sha256")
			.update(JSON.stringify({ record, members, requiresRestart }))
			.digest("hex");
		return {
			status: reason ? "unavailable" : "available",
			reason,
			generation,
			members,
			baseCommit: members.find((member) => member.projectId === projectId)?.baseCommit ?? null,
			snapshot,
			requiresRestart,
		};
	}

	return {
		contexts(reference: IssueReference, stage: "design" | "implementation") {
			return run(reference, async (_key, record) => {
				const ids = [projectId, ...selection(record)];
				const taken = new Set([...ids, ...(record.members ?? []).map((m) => m.projectId)]);
				const references = ((await options.references?.()) ?? [])
					.filter((candidate) => !taken.has(candidate.projectId))
					.map((candidate) => ({
						projectId: candidate.projectId,
						workspaceId: candidate.workspaceId,
						path: candidate.path,
						role: "reference" as const,
					}));
				const joined = await Promise.all(
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
				return [...joined, ...references];
			});
		},
		repositories(reference: IssueReference) {
			return run(reference, async (_key, record) => ({
				projectIds: selection(record),
				locked: locked(record),
			}));
		},
		/**
		 * Add one repository: before preparation it extends the saved selection; afterwards it joins the
		 * running implementation at once, in the same frozen slot. Add-only; resuming a half-made join.
		 */
		addRepository(reference: IssueReference, memberId: string) {
			return run(reference, async (key, record) => {
				if (!isIssueRepositoriesInput({ projectId, reference, projectIds: [memberId] }))
					refuse("That repository cannot join this Issue.");
				if (!locked(record)) {
					const ids = selection(record);
					if (!ids.includes(memberId)) {
						if (ids.length >= MAX_MEMBERS)
							refuse(`An Issue can join at most ${MAX_MEMBERS} repositories besides its own.`);
						ids.push(memberId);
						await options.save(key, { ...record, repositoryProjectIds: ids });
					}
					return { projectIds: ids, locked: false };
				}
				if (record.implementation?.state !== "completed")
					refuse("Start the Issue's implementation before joining more repositories.");
				record.members ??= [];
				record.repositoryProjectIds ??= [];
				record = await settleRemovals(key, record);
				if (!record.members?.some((member) => member.projectId === memberId))
					await admitMember(key, record, memberId);
				await prepareMember(key, record, memberId);
				return { projectIds: selection(record), locked: true };
			});
		},
		/**
		 * Remove joined members whose worktree has no commit beyond its recorded base and no change,
		 * deepest first; a member still holding another checkout, or without a recorded base, stays.
		 */
		cleanupRepositories(reference: IssueReference) {
			return run(reference, async (key, record) => {
				if (record.implementation?.state !== "completed")
					refuse("Start the Issue's implementation before cleaning up its repositories.");
				record = await settleRemovals(key, record);
				const candidates: { id: string; path: string }[] = [];
				for (const id of selection(record))
					candidates.push({ id, path: await worktreePathFor(record, id) });
				candidates.sort((a, b) => segments(b.path).length - segments(a.path).length);
				const removed: string[] = [];
				for (const { id, path } of candidates) {
					const member = record.members?.find((candidate) => candidate.projectId === id);
					const ownership = member?.ownership;
					if (!member?.base || ownership?.state !== "completed") continue;
					if (!options.memberUnchanged || !options.removeMember) break;
					const holders = await joinedPaths(record);
					if (holders.some((other) => other.projectId !== id && inside(other.path, path))) continue;
					let ws: WorkspaceHandle;
					try {
						ws = await verifyImplementation(ownership, path, id);
					} catch {
						continue;
					}
					if (!(await options.memberUnchanged(ws, member.base))) continue;
					member.removing = true;
					await options.save(key, record);
					record = await settleRemovals(key, record);
					if (!record.members?.some((candidate) => candidate.projectId === id)) removed.push(id);
				}
				return { projectIds: selection(record), locked: true, removed };
			});
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
		implementationRecovery(reference: IssueReference): Promise<IssueImplementationRecovery> {
			return run(reference, async (_key, record) => diagnoseRecovery(record), false, true);
		},
		recoverImplementation(
			reference: IssueReference,
			input: IssueImplementationRecoveryInput,
		): Promise<IssueSessionLaunch> {
			return run(reference, async (key, record) => {
				if (
					!isIssueImplementationRecoveryInput(input) ||
					keyFor(input.projectId, input.reference) !== key
				)
					stop();
				const diagnosis = await diagnoseRecovery(record);
				if (
					diagnosis.status !== "available" ||
					diagnosis.snapshot !== input.snapshot ||
					(diagnosis.requiresRestart && !input.restart)
				)
					stop();
				const next = structuredClone(record);
				for (const member of diagnosis.members) {
					const ownership =
						member.projectId === projectId
							? next.implementation
							: next.members?.find((row) => row.projectId === member.projectId)?.ownership;
					if (ownership?.state !== "completed" || !member.baseCommit) stop();
					if (member.projectId === projectId) {
						next.implementationHistory = [
							...(next.implementationHistory ?? []),
							{
								workspaceId: ownership.workspaceId,
								worktreePath: ownership.worktreePath,
								branch: ownership.branch,
								...(ownership.session ? { sessionId: ownership.session.id } : {}),
								archivedAt: Date.now(),
							},
						];
					}
					const pending: PendingWorkspace = {
						state: "pending",
						worktreePath: ownership.worktreePath,
						branch: `issue-${reference.number}-${randomUUID()}`,
						recoveryCommit: member.baseCommit,
					};
					if (member.projectId === projectId) next.implementation = pending;
					else {
						const row = next.members?.find((row) => row.projectId === member.projectId);
						if (!row) stop();
						row.ownership = pending;
						row.base = member.baseCommit;
					}
				}
				await options.save(key, next);
				return prepareImplementation(key, next);
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
					if (existing && (await sessionStatus(workspaceId, existing)))
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
			return run(reference, async (key, record) => prepareImplementation(key, record), true);
		},
	};
}
