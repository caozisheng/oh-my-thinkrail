import type { GitDiffScope, PiEvent, TurnChangeSet } from "@thinkrail/contracts";
import { gitStatus, snapshotWorktree } from "../git";
import { logger } from "../log";
import { loadTurns, loadWorkspaces, saveTurns } from "../persistence";

const log = logger("turns");
const TURNS_PER_WORKSPACE = 30;
const DRAIN_TIMEOUT_MS = 5_000;

interface MemberTarget {
	workspaceId: string;
	worktreePath: string;
}

interface PendingTarget extends MemberTarget {
	baseTree: Promise<string | null>;
}

interface PendingRun {
	targets: PendingTarget[];
	startedAt: number;
	/** Membership is known synchronously for the default port; a host lookup may still settle. */
	pending?: Promise<void>;
}

type TurnPublisher = (turn: TurnChangeSet) => void;
let publishTurn: TurnPublisher = () => {};

export function setTurnPublisher(fn: TurnPublisher): void {
	publishTurn = fn;
}

export function turnScope(turn: TurnChangeSet): Extract<GitDiffScope, { kind: "turn" }> {
	return {
		kind: "turn",
		id: turn.id,
		baseTree: turn.baseTree,
		headTree: turn.headTree,
		startedAt: turn.startedAt,
	};
}

export function listTurns(workspaceId: string): TurnChangeSet[] {
	return loadTurns().byWorkspace[workspaceId] ?? [];
}

export function forgetWorkspaceTurns(workspaceId: string): void {
	const turns = loadTurns();
	if (!(workspaceId in turns.byWorkspace)) return;
	const { [workspaceId]: _dropped, ...byWorkspace } = turns.byWorkspace;
	saveTurns({ ...turns, byWorkspace });
}

function recordTurn(turn: TurnChangeSet): void {
	const turns = loadTurns();
	const existing = turns.byWorkspace[turn.workspaceId] ?? [];
	const next = [...existing.filter((t) => t.id !== turn.id), turn]
		.sort((a, b) => a.startedAt - b.startedAt)
		.slice(-TURNS_PER_WORKSPACE);
	saveTurns({ ...turns, byWorkspace: { ...turns.byWorkspace, [turn.workspaceId]: next } });
}

export class TurnTracker {
	private readonly pending = new Map<string, PendingRun>();
	private readonly recording = new Set<Promise<void>>();
	private readonly resolve: (
		sessionId: string,
	) => { workspaceId: string; worktreePath: string } | null;
	private readonly members: (sessionId: string) => MemberTarget[] | Promise<MemberTarget[]>;
	private readonly now: () => number;
	private readonly snapshot: (worktreePath: string) => Promise<string | null>;

	constructor(
		resolve: (sessionId: string) => { workspaceId: string; worktreePath: string } | null,
		now: () => number = Date.now,
		snapshot: (worktreePath: string) => Promise<string | null> = snapshotWorktree,
		members: (sessionId: string) => MemberTarget[] | Promise<MemberTarget[]> = () => [],
	) {
		this.resolve = resolve;
		this.now = now;
		this.snapshot = snapshot;
		this.members = members;
	}

	async observe(sessionId: string, event: PiEvent): Promise<void> {
		if (event.type === "agent_start") {
			if (this.pending.has(sessionId)) return;
			const target = this.resolve(sessionId);
			if (!target) return;
			// One Issue session can own several source repositories; each keeps its own snapshot. Identity
			// stays workspace id + repo-relative path, so identical paths in two repos never collide.
			const run: PendingRun = {
				targets: [{ ...target, baseTree: this.snapshot(target.worktreePath).catch(() => null) }],
				startedAt: this.now(),
			};
			this.pending.set(sessionId, run);
			const add = (members: MemberTarget[]) => {
				for (const member of members) {
					if (run.targets.some((known) => known.workspaceId === member.workspaceId)) continue;
					run.targets.push({
						...member,
						baseTree: this.snapshot(member.worktreePath).catch(() => null),
					});
				}
			};
			const members = this.members(sessionId);
			if (Array.isArray(members)) add(members);
			else run.pending = members.then(add, () => {});
			await Promise.all([
				...run.targets.map((known) => known.baseTree),
				run.pending ?? Promise.resolve(),
			]);
			return;
		}
		if (event.type !== "agent_settled") return;
		const run = this.pending.get(sessionId);
		this.pending.delete(sessionId);
		if (!run) return;
		// Capture every head at settlement, never after a slow base or membership lookup.
		const heads = run.targets.map((target) => this.snapshot(target.worktreePath));
		const job = this.settle(sessionId, run, heads).catch((error) => {
			log.warn(`turn change set was not recorded for ${sessionId}`, error as Error);
		});
		this.recording.add(job);
		void job.then(() => this.recording.delete(job));
		return job;
	}

	async drain(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.all(this.recording),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
		clearTimeout(timer);
	}

	private async settle(
		sessionId: string,
		run: PendingRun,
		heads: Promise<string | null>[],
	): Promise<void> {
		await run.pending;
		for (const target of run.targets.slice(heads.length))
			heads.push(this.snapshot(target.worktreePath));
		for (const [index, target] of run.targets.entries()) {
			const [baseTree, headTree] = await Promise.all([
				target.baseTree,
				heads[index] ?? Promise.resolve(null),
			]);
			if (!baseTree || !headTree || headTree === baseTree) continue;
			const id = `${sessionId}:${run.startedAt}`;
			const status = await gitStatus(target.workspaceId, {
				kind: "turn",
				id,
				baseTree,
				headTree,
				startedAt: run.startedAt,
			});
			if (status.changes.length === 0) continue;
			if (!loadWorkspaces().some((workspace) => workspace.id === target.workspaceId)) continue;
			const turn: TurnChangeSet = {
				id,
				workspaceId: target.workspaceId,
				sessionId,
				startedAt: run.startedAt,
				settledAt: this.now(),
				baseTree,
				headTree,
				changes: status.changes,
			};
			recordTurn(turn);
			publishTurn(turn);
		}
	}
}
