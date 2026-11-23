import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MatrixConnectionInput, MatrixStatus } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	abortSession,
	ensureSessionAttached,
	followUpSession,
	getSessionMessages,
	listSessionStates,
	respondToTool,
	startInitialSessionPrompt,
	steerSession,
} from "../agent";
import {
	createMatrixService,
	emptyProjection,
	type MatrixProjectionState,
	type MatrixRecord,
	type MatrixService,
	type MatrixSessionTarget,
} from "../matrix";
import { dataDir } from "../persistence";
import { getProjects } from "../projects";
import { listAllWorkspaceRecords } from "../workspaces";
import { createMatrixCredentials } from "./matrixCredentials";
import { matrixAnswer, matrixQuestions } from "./matrixInteractions";

export interface MatrixRequestContext {
	protocolVersion?: number;
}

function requireProtocol(ctx?: MatrixRequestContext) {
	if (ctx?.protocolVersion !== undefined && ctx.protocolVersion < 143)
		throw new CodedError("RESOURCE_UNAVAILABLE", "Matrix integration needs a newer host client.");
}

function matrixPath(): string {
	return join(dataDir(), "matrix");
}

function persistence() {
	const file = join(matrixPath(), "connection.json");
	return {
		async load(): Promise<MatrixRecord | null> {
			try {
				const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
					throw new Error("invalid");
				return parsed as MatrixRecord;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		},
		async save(value: MatrixRecord | null): Promise<void> {
			mkdirSync(matrixPath(), { recursive: true, mode: 0o700 });
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				if (value) writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
				if (value) renameSync(temporary, file);
				else rmSync(file, { force: true });
			} finally {
				rmSync(temporary, { force: true });
			}
		},
	};
}

async function catalog(): Promise<MatrixSessionTarget[]> {
	const projects = getProjects().filter(
		(project) => !project.closed && project.kind !== "chats" && project.trusted,
	);
	const workspaces = listAllWorkspaceRecords().filter((workspace) =>
		projects.some((project) => project.id === workspace.projectId),
	);
	const states = await listSessionStates(
		workspaces.map((workspace) => ({
			id: workspace.id,
			projectId: workspace.projectId,
			cwd: workspace.worktreePath,
		})),
	);
	const currentProjects = getProjects().filter(
		(project) => !project.closed && project.kind !== "chats" && project.trusted,
	);
	const currentWorkspaces = listAllWorkspaceRecords();
	return states.flatMap((row) => {
		const workspace = currentWorkspaces.find((item) => item.id === row.workspaceId);
		const project = currentProjects.find((item) => item.id === row.projectId);
		return workspace && project
			? [
					{
						...row,
						projectName: project.name,
						workspaceName: workspace.name,
						title: row.title ?? "",
					},
				]
			: [];
	});
}
function assertTargetPolicy(target: MatrixSessionTarget): void {
	const project = getProjects().find((row) => row.id === target.projectId);
	const workspace = listAllWorkspaceRecords().find((row) => row.id === target.workspaceId);
	if (
		!project ||
		project.closed ||
		!project.trusted ||
		project.kind === "chats" ||
		workspace?.projectId !== project.id
	)
		throw new CodedError("RESOURCE_UNAVAILABLE", "Matrix session is unavailable.");
}
async function validateTarget(target: MatrixSessionTarget): Promise<MatrixSessionTarget> {
	const fresh = (await catalog()).find(
		(row) =>
			row.sessionId === target.sessionId &&
			row.workspaceId === target.workspaceId &&
			row.projectId === target.projectId,
	);
	if (!fresh) throw new CodedError("RESOURCE_UNAVAILABLE", "Matrix session is unavailable.");
	assertTargetPolicy(fresh);
	return fresh;
}
function projectionStore() {
	const file = join(matrixPath(), "projection.json");
	return {
		async load(): Promise<MatrixProjectionState> {
			try {
				return JSON.parse(readFileSync(file, "utf8")) as MatrixProjectionState;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyProjection();
				throw new Error("Matrix projection unavailable");
			}
		},
		async save(state: MatrixProjectionState) {
			mkdirSync(matrixPath(), { recursive: true, mode: 0o700 });
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
				renameSync(temporary, file);
			} finally {
				rmSync(temporary, { force: true });
			}
		},
	};
}

let service: MatrixService | undefined;
let hostStopped = false;
let publish: ((status: MatrixStatus) => void) | null = null;
let unsubscribe: (() => void) | undefined;
function current(): MatrixService {
	if (hostStopped) throw new CodedError("RESOURCE_UNAVAILABLE", "Matrix host is stopped.");
	service ??= createMatrixService({
		credentials: createMatrixCredentials({ namespace: `profile:${dataDir()}` }),
		persistence: persistence(),
		bridge: {
			store: projectionStore(),
			host: {
				catalog,
				async transcript(target) {
					await validateTarget(target);
					const workspace = listAllWorkspaceRecords().find((row) => row.id === target.workspaceId);
					if (!workspace) throw new Error("Unknown workspace");
					return (
						await getSessionMessages(target.sessionId, target.workspaceId, workspace.worktreePath)
					).messages;
				},
				async prompt(target, text, followup) {
					await validateTarget(target);
					const workspace = listAllWorkspaceRecords().find((row) => row.id === target.workspaceId);
					if (!workspace) throw new Error("Unknown workspace");
					await ensureSessionAttached(target.sessionId, target.workspaceId, workspace.worktreePath);
					const fresh = await validateTarget(target);
					if (fresh.state.execution === "running") {
						if (followup) await followUpSession(target.sessionId, text);
						else await steerSession(target.sessionId, text);
					} else await startInitialSessionPrompt(target.sessionId, text);
				},
				async interaction(target) {
					const fresh = await validateTarget(target);
					const pending = fresh.state.needsInput;
					if (!pending) return null;
					const workspace = listAllWorkspaceRecords().find((row) => row.id === target.workspaceId);
					if (!workspace) return null;
					if (pending.kind === "dialog")
						return "This interaction requires the ThinkRail web UI; Matrix cannot safely display its complete approval scope.";
					const messages = (
						await getSessionMessages(target.sessionId, target.workspaceId, workspace.worktreePath)
					).messages;
					const questions = matrixQuestions(messages, pending.toolCallId);
					if (!questions) return "This interaction requires the ThinkRail web UI.";
					return (
						questions
							.map(
								(question, index) =>
									`${index + 1}. ${question.question}\n${question.options.map((option, i) => `  ${i + 1}) ${option.label} — ${option.description}`).join("\n")}`,
							)
							.join("\n\n") +
						`\nReply: !omt answer ${pending.interactionId} <option numbers; one answer per question>. Use commas for multiple selections, text:<answer> for free text, skip to decline.`
					);
				},
				async answer(target, interactionId, text) {
					const fresh = await validateTarget(target);
					const pending = fresh.state.needsInput;
					if (!pending || pending.interactionId !== interactionId)
						throw new Error("Expired interaction");
					if (pending.kind === "dialog")
						throw new Error("This interaction requires the ThinkRail web UI");
					const workspace = listAllWorkspaceRecords().find((row) => row.id === target.workspaceId);
					if (!workspace) throw new Error("Unknown workspace");
					const messages = (
						await getSessionMessages(target.sessionId, target.workspaceId, workspace.worktreePath)
					).messages;
					const questions = matrixQuestions(messages, pending.toolCallId);
					if (!questions) throw new Error("Unsupported interaction");
					const latest = await validateTarget(target);
					if (latest.state.needsInput?.interactionId !== interactionId)
						throw new Error("Expired interaction");
					await respondToTool(target.sessionId, pending.toolCallId, matrixAnswer(questions, text));
				},
				async stop(target, runId) {
					const fresh = await validateTarget(target);
					if (fresh.state.runId !== runId) throw new Error("Expired run");
					await abortSession(target.sessionId);
				},
			},
		},
	});
	if (publish && !unsubscribe) unsubscribe = service.connectPublisher(publish);
	return service;
}

export function setMatrixPublisher(next: ((status: MatrixStatus) => void) | null): void {
	publish = next;
	unsubscribe?.();
	unsubscribe = undefined;
	if (next && service) unsubscribe = service.connectPublisher(next);
}

export async function matrixStatus(ctx?: MatrixRequestContext): Promise<MatrixStatus> {
	requireProtocol(ctx);
	const matrix = current();
	await matrix.restore().catch(() => undefined);
	return matrix.status();
}

export function matrixConfigure(
	input: MatrixConnectionInput,
	ctx?: MatrixRequestContext,
): Promise<MatrixStatus> {
	requireProtocol(ctx);
	return current().configure(input);
}

export function matrixDisconnect(ctx?: MatrixRequestContext): Promise<MatrixStatus> {
	requireProtocol(ctx);
	return current().disconnect();
}

export async function matrixSync(ctx?: MatrixRequestContext): Promise<MatrixStatus> {
	requireProtocol(ctx);
	await current().restore();
	return current().sync();
}

export async function stopMatrix(): Promise<void> {
	hostStopped = true;
	unsubscribe?.();
	unsubscribe = undefined;
	if (service) await service.stop();
	service = undefined;
}

export function resetMatrixForHostStart(): void {
	hostStopped = false;
}
