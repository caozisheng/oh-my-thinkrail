import type { GitFileChange, PiEvent } from "@thinkrail/contracts";
import { WORKSPACE_INTERNAL_DIR } from "@thinkrail/shared/paths";
import { type TodoArtifact, type TodoPlan, TodoStore } from "pi-todos/core";
import {
	gitCommitPaths,
	gitHeadSha,
	gitStatus,
	gitUncommittedPaths,
	listCommitsSince,
} from "../git";
import { logger } from "../log";
import { getWorkspace } from "../workspaces";
import {
	type Baseline,
	baselineKey,
	baselineTodoId,
	baselineWorkspaceId,
	markOtherSessionWindowsShared,
	otherSessionWindows,
	readBaselines,
	writeBaselines,
} from "./baselines";
import { dropReviewRecord } from "./reviews";

const log = logger("todos");

export type CommitWindow = (opts: { subject: string; paths: string[] }) => { sha: string } | null;

const isAppStatePath = (path: string): boolean =>
	path === WORKSPACE_INTERNAL_DIR || path.startsWith(`${WORKSPACE_INTERNAL_DIR}/`);

export function isTodoToolEnd(event: PiEvent): boolean {
	return (
		event.type === "tool_execution_end" &&
		typeof event.toolName === "string" &&
		event.toolName.startsWith("todo_")
	);
}

function flatten(plan: TodoPlan): TodoPlan["todos"] {
	return [...plan.todos, ...plan.groups.flatMap((g) => g.todos)];
}

const commitQueues = new Map<string, Promise<void>>();

export function enqueueTodoMutation<T>(workspaceId: string, fn: () => T | Promise<T>): Promise<T> {
	const prev = commitQueues.get(workspaceId);
	let reservation: Promise<void> | undefined;
	let next: Promise<T>;
	if (prev) {
		next = prev.then(fn);
	} else {
		let releaseReservation!: () => void;
		reservation = new Promise<void>((resolve) => {
			releaseReservation = resolve;
		});
		commitQueues.set(workspaceId, reservation);
		next = new Promise<T>((resolve, reject) => {
			try {
				resolve(fn());
			} catch (error) {
				reject(error);
			}
		});
		void next.then(releaseReservation, releaseReservation);
	}
	const tail = next.then(
		() => undefined,
		() => undefined,
	);
	if (reservation && commitQueues.get(workspaceId) !== reservation) return next;
	commitQueues.set(workspaceId, tail);
	void tail.finally(() => {
		if (commitQueues.get(workspaceId) === tail) commitQueues.delete(workspaceId);
	});
	return next;
}

function captureNewWorkWindow(workspaceId: string, sessionId: string, scope?: string): void {
	const root = getWorkspace(workspaceId).worktreePath;
	const store = new TodoStore(root, sessionId);
	const active = flatten(store.read()).find((item) => item.status === "in_progress");
	if (!active) return;
	const baselines = readBaselines(root, sessionId);
	const key = baselineKey(active.id, scope);
	if (baselines[key]) return;
	const shared = otherSessionWindows(root, sessionId);
	baselines[key] = {
		paths: gitUncommittedPaths(workspaceId).filter((path) => !isAppStatePath(path)),
		head: gitHeadSha(workspaceId),
		...(shared && { shared }),
	};
	if (shared) markOtherSessionWindowsShared(root, sessionId);
	writeBaselines(root, sessionId, baselines);
}

export function maybeAttachChangeArtifacts(workspaceId: string, sessionId: string): Promise<void> {
	try {
		captureNewWorkWindow(workspaceId, sessionId);
	} catch {
		log.warn(`todo work-window capture skipped (${workspaceId}/${sessionId})`);
	}
	const reconcile = enqueueTodoMutation(workspaceId, () => runReconcile(workspaceId, sessionId));
	const attachMembers = (members: readonly string[]) =>
		Promise.all([
			reconcile,
			...members.map((member) => {
				try {
					captureNewWorkWindow(workspaceId, sessionId, member);
				} catch {
					log.warn(`todo member work-window capture skipped (${member}/${sessionId})`);
				}
				return enqueueTodoMutation(member, () => runReconcile(workspaceId, sessionId, member));
			}),
		]).then(() => undefined);
	const members = sessionMemberWorkspaces(workspaceId, sessionId);
	return Array.isArray(members)
		? attachMembers(members)
		: Promise.resolve(members)
				.catch(() => [])
				.then(attachMembers);
}

/**
 * Associated source-repository workspaces this session may also modify. The host installs the lookup;
 * an unknown session yields none, so a single-repository session behaves exactly as before.
 */
let sessionMemberWorkspaces: (
	workspaceId: string,
	sessionId: string,
) => readonly string[] | Promise<readonly string[]> = () => [];

export function setSessionMemberWorkspaces(
	resolve: (
		workspaceId: string,
		sessionId: string,
	) => readonly string[] | Promise<readonly string[]>,
): void {
	sessionMemberWorkspaces = resolve;
}

export async function settleChangeArtifacts(workspaceId: string): Promise<void> {
	let current = commitQueues.get(workspaceId);
	while (current) {
		await current;
		const next = commitQueues.get(workspaceId);
		if (next === current) return;
		current = next;
	}
}

async function runReconcile(workspaceId: string, sessionId: string, scope?: string): Promise<void> {
	try {
		const root = getWorkspace(workspaceId).worktreePath;
		const store = new TodoStore(root, sessionId);
		const target = scope ?? workspaceId;
		await reconcileChangeArtifacts(
			store,
			root,
			sessionId,
			async () => (await gitStatus(target, { kind: "uncommitted" })).changes.map((c) => c.path),
			({ subject, paths }) => gitCommitPaths(target, subject, paths),
			() => gitHeadSha(target),
			false,
			(head) => listCommitsSince(target, head),
			scope,
		);
	} catch {
		log.warn(`todo change-artifacts skipped (${workspaceId}/${sessionId})`);
	}
}

function hasChangeSet(artifacts: TodoArtifact[] | undefined): boolean {
	return artifacts?.some((a) => a.kind === "change" || a.kind === "commit") ?? false;
}

export function unattributedChanges(
	changes: GitFileChange[],
	plan: TodoPlan,
	baselines: Record<string, Baseline>,
	workspaceId?: string,
): GitFileChange[] {
	const items = flatten(plan);
	const attributed = new Set(
		items.flatMap((t) =>
			(t.artifacts ?? []).flatMap((a) =>
				a.kind === "change" && a.path && a.workspaceId === workspaceId ? [a.path] : [],
			),
		),
	);
	const openWindows = items.flatMap((t) => {
		const base = baselines[baselineKey(t.id, workspaceId)];
		return t.status === "in_progress" && base ? [base] : [];
	});
	return changes.filter(
		(c) =>
			!isAppStatePath(c.path) &&
			!attributed.has(c.path) &&
			openWindows.every((b) => b.paths.includes(c.path)),
	);
}

export type WindowCommits = (head: string | null) => Promise<{ sha: string; subject: string }[]>;

export async function reconcileChangeArtifacts(
	store: TodoStore,
	root: string,
	sessionId: string,
	getChangedPaths: () => Promise<string[]>,
	commit?: CommitWindow,
	getHead: () => string | null = () => null,
	openMissingWorkWindow = true,
	windowCommits?: WindowCommits,
	workspaceId?: string,
): Promise<void> {
	const plan = store.read();
	let planFingerprint = JSON.stringify(plan);
	const planUnchanged = (): boolean => JSON.stringify(store.read()) === planFingerprint;
	const acceptPlanWrite = (): void => {
		planFingerprint = JSON.stringify(store.read());
	};
	const baselines = readBaselines(root, sessionId);
	let persistedBaselineFingerprint = JSON.stringify(baselines);
	const baselinesUnchanged = (): boolean =>
		JSON.stringify(readBaselines(root, sessionId)) === persistedBaselineFingerprint;
	let baselinesDirty = false;
	const flushBaselines = (): boolean => {
		if (!baselinesDirty) return true;
		if (!planUnchanged()) return false;
		if (!baselinesUnchanged()) return false;
		writeBaselines(root, sessionId, baselines);
		persistedBaselineFingerprint = JSON.stringify(baselines);
		baselinesDirty = false;
		return true;
	};
	const dropBaseline = (id: string): void => {
		if (baselines[id] === undefined) return;
		delete baselines[id];
		baselinesDirty = true;
	};
	let changed: string[] | null = null;
	const currentChanged = async (): Promise<string[]> =>
		(changed ??= (await getChangedPaths()).filter((p) => !isAppStatePath(p)));
	let othersOpen: boolean | null = null;
	const otherChatWorking = (): boolean => (othersOpen ??= otherSessionWindows(root, sessionId));

	const items = flatten(plan);
	const owned = new Set(
		items.flatMap((t) =>
			(t.artifacts ?? []).flatMap((a) => (a.kind === "commit" && a.sha ? [a.sha] : [])),
		),
	);
	const liveIds = new Set(items.map((t) => t.id));
	for (const id of Object.keys(baselines)) {
		if (baselineWorkspaceId(id) === workspaceId && !liveIds.has(baselineTodoId(id)))
			dropBaseline(id);
	}
	if (!flushBaselines()) return;
	const windowIds = new Set(
		Object.keys(baselines).filter((id) => baselineWorkspaceId(id) === workspaceId),
	);
	for (const todo of items) {
		const key = baselineKey(todo.id, workspaceId);
		const scope = workspaceId === undefined ? {} : { workspaceId };
		if (todo.status === "in_progress") {
			if (!baselines[key] && openMissingWorkWindow) {
				const paths = await currentChanged();
				if (!planUnchanged() || !baselinesUnchanged()) return;
				const shared = otherChatWorking();
				baselines[key] = {
					paths,
					head: getHead(),
					...(shared && { shared }),
				};
				if (shared) markOtherSessionWindowsShared(root, sessionId);
				baselinesDirty = true;
			}
			if (!flushBaselines()) return;
			continue;
		}
		if (todo.status !== "done") {
			dropBaseline(key);
			if (!flushBaselines()) return;
			continue;
		}
		const base: Baseline | undefined = baselines[key];
		dropBaseline(key);
		const existing = todo.artifacts ?? [];
		const existingInScope = existing.filter((a) => a.workspaceId === workspaceId);
		if (hasChangeSet(existingInScope) && base === undefined) continue;
		const now = await currentChanged();
		if (!planUnchanged() || !baselinesUnchanged()) return;
		const deltaPaths = base ? now.filter((p) => !base.paths.includes(p)) : [];
		const exclusive = base?.shared !== true && !otherChatWorking();
		const soleWindow = [...windowIds].every((id) => baselineTodoId(id) === todo.id);
		const adopted: TodoArtifact[] = [];
		if (windowCommits && base?.head && exclusive && soleWindow) {
			const ranged = await windowCommits(base.head);
			if (!planUnchanged() || !baselinesUnchanged()) return;
			for (const c of ranged) {
				if (owned.has(c.sha)) continue;
				owned.add(c.sha);
				adopted.push({ kind: "commit", sha: c.sha, label: c.subject || todo.title, ...scope });
			}
		}
		if (deltaPaths.length === 0 && adopted.length === 0) {
			if (!flushBaselines()) return;
			continue;
		}
		const preserved = existing.filter((a) => a.kind !== "change" || a.workspaceId !== workspaceId);
		const committed =
			commit && deltaPaths.length > 0 && base?.paths.every((p) => !now.includes(p)) && exclusive
				? commit({
						subject: (todo.commitSubject ?? todo.title).split(/[\r\n]/u, 1)[0] ?? "",
						paths: deltaPaths,
					})
				: null;
		if (committed) {
			owned.add(committed.sha);
			changed = null;
			store.update(todo.id, {
				artifacts: [
					...preserved,
					...adopted,
					{ kind: "commit", sha: committed.sha, label: todo.title, ...scope },
				],
			});
			acceptPlanWrite();
			if (!flushBaselines()) return;
			continue;
		}
		const changes = deltaPaths.map((path): TodoArtifact => ({ kind: "change", path, ...scope }));
		store.update(todo.id, { artifacts: [...preserved, ...adopted, ...changes] });
		acceptPlanWrite();
		// A path-list `change` delta can't be watermarked by sha, and `reviewInfo` only derives
		// `unreviewedShas` from commits — so a change riding alongside adopted commits would be invisible
		// to review state (a covered sha set could read fully reviewed while the path delta went unseen).
		// Keep the record only when the fresh attachment is entirely SHA-backed (pure adoption); any live
		// path-list delta drops it → review afresh. autoCycles is a separate durable map, untouched.
		if (changes.length > 0) dropReviewRecord(root, sessionId, todo.id);
		if (!flushBaselines()) return;
	}
}
