import { createHash } from "node:crypto";
import type { SessionState } from "@thinkrail/contracts";
import {
	ContentHelpers,
	EventType,
	type MatrixClient,
	type MatrixEvent,
	Preset,
	ReceiptType,
	RelationType,
	RoomType,
	Visibility,
} from "matrix-js-sdk";
import {
	isMarkdownContinuation,
	MATRIX_EVENT_CONTENT_MAX_BYTES,
	MATRIX_STREAM_CHUNK_MAX_BYTES,
	matrixFormattedContent,
	projectionTransactionId,
	transcriptProjection,
} from "./bridge";
import { assistantMessageKey } from "./liveEvents";
import type { MatrixDiagnosticCode } from "./service";

export interface MatrixSessionTarget {
	projectId: string;
	projectName: string;
	workspaceId: string;
	workspaceName: string;
	sessionId: string;
	title: string;
	state: SessionState;
}
export interface MatrixHostPort {
	catalog(): Promise<MatrixSessionTarget[]>;
	transcript(target: MatrixSessionTarget): Promise<readonly unknown[]>;
	prompt(target: MatrixSessionTarget, text: string, followup: boolean): Promise<void>;
	stop(target: MatrixSessionTarget, runId: string): Promise<void>;
	interaction(target: MatrixSessionTarget): Promise<string | null>;
	answer(target: MatrixSessionTarget, interactionId: string, text: string): Promise<void>;
}
export interface MatrixRoomMapping {
	historyFormat?: "markdown-v1";
	roomId?: string;
	creating?: true;
	projectId: string;
	workspaceId: string;
	sessionId: string;
	projectRoomId?: string;
	projectCreating?: true;
	sent: string[];
	streams?: Record<
		string,
		{
			text?: string;
			final?: boolean;
			chunkSize?: number;
			chunks: {
				eventId?: string;
				text?: string;
				revision: number;
				pending?: string;
				pendingContent?: object;
			}[];
			pending?: { text: string; final: boolean };
		}
	>;
}
export interface MatrixProjectionState {
	identity?: { bot: string; homeserver: string; controller: string };
	formerControllers?: string[];
	controlRoomId?: string;
	controlCreating?: true;
	explicitSessionIds?: string[];
	rootRoomId?: string;
	rootCreating?: true;
	projects: Record<string, { roomId?: string; creating?: true }>;
	sessions: Record<string, MatrixRoomMapping>;
	inbox: Record<string, { phase: "dispatching" | "done" | "unknown"; roomId: string }>;
}
export interface MatrixProjectionStore {
	load(): Promise<MatrixProjectionState>;
	save(state: MatrixProjectionState): Promise<void>;
}

export function emptyProjection(): MatrixProjectionState {
	return { projects: {}, sessions: {}, inbox: {} };
}

export function createMatrixProjection(options: {
	diagnostic?: (code: MatrixDiagnosticCode) => void;
	client: MatrixClient;
	controller: string;
	bot: string;
	homeserver: string;
	host: MatrixHostPort;
	store: MatrixProjectionStore;
	allowed: () => boolean;
}) {
	const diagnostic = (code: MatrixDiagnosticCode) => {
		try {
			options.diagnostic?.(code);
		} catch {}
	};
	let state = emptyProjection();
	let targets: MatrixSessionTarget[] = [];
	let loaded = false;
	// Cooperative checkpoints admit host controls. Any attempted mutation invalidates
	// the captured catalog/transcript, including unknown dispatch outcomes. Abandon
	// the remaining pass; the next reconcile refreshes state and exact ownership.
	let controlGeneration = 0;
	const summary = () => ({
		projects: Object.keys(state.projects).length,
		sessions: Object.keys(state.sessions).length,
		backfilled: Object.values(state.sessions).reduce((n, row) => n + row.sent.length, 0),
		pendingControls: Object.values(state.inbox).filter((row) => row.phase === "unknown").length,
	});
	const save = () => options.store.save(structuredClone(state));
	const assertActive = () => {
		if (!options.allowed()) throw new Error("Matrix integration stopped");
	};
	const send = async (
		roomId: string,
		text: string,
		key: string,
		allowFormatted = true,
		prefix = "",
	) => {
		assertActive();
		await ensureSafe(roomId);
		assertActive();
		const markdown = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
		const rendered = await matrixFormattedContent(prefix, markdown, { allowFormatted });
		const content = rendered.formatted_body
			? ContentHelpers.makeHtmlNotice(rendered.body, rendered.formatted_body)
			: ContentHelpers.makeNotice(rendered.body);
		await options.client.sendEvent(
			roomId,
			EventType.RoomMessage,
			content as never,
			projectionTransactionId(key),
		);
	};
	const makeRoom = async (name: string, space: boolean, topic?: string) => {
		assertActive();
		const result = await options.client.createRoom({
			name,
			...(topic ? { topic } : {}),
			visibility: Visibility.Private,
			preset: Preset.PrivateChat,
			invite: [options.controller],
			...(space ? { creation_content: { type: RoomType.Space } } : {}),
			power_level_content_override: {
				users: { [options.bot]: 100, [options.controller]: 10 },
				users_default: 0,
				events_default: 10,
				state_default: 100,
				invite: 100,
				kick: 100,
				ban: 100,
				redact: 100,
			},
		});
		return result.room_id;
	};
	const configureRoomController = async (roomId: string) => {
		const events = await options.client.roomState(roomId);
		const membership = events.find(
			(event) => event.type === "m.room.member" && event.state_key === options.controller,
		)?.content?.membership;
		if (membership !== "join" && membership !== "invite")
			await options.client.invite(roomId, options.controller);
		const powerLevelsEvent = events.find((event) => event.type === EventType.RoomPowerLevels);
		const content = structuredClone(powerLevelsEvent?.content ?? {});
		const users = { ...(content.users ?? {}) };
		let changed = users[options.controller] !== 10;
		users[options.controller] = 10;
		for (const former of state.formerControllers ?? []) {
			if (former !== options.controller && users[former] !== 0) {
				users[former] = 0;
				changed = true;
			}
		}
		if (changed) {
			await options.client.sendStateEvent(roomId, EventType.RoomPowerLevels, { ...content, users });
		}
	};
	const ensureSafe = async (roomId: string) => {
		const events = await options.client.roomState(roomId);
		if (events.some((event) => event.type === "m.room.encryption"))
			throw new Error("Encrypted Matrix room unsupported");
		const join = events.find((event) => event.type === "m.room.join_rules");
		if (join?.content?.join_rule !== "invite")
			throw new Error("Matrix room must remain invite-only");
	};
	const link = async (parent: string, child: string) => {
		const via = options.bot.slice(options.bot.indexOf(":") + 1);
		await options.client.sendStateEvent(
			parent,
			EventType.SpaceChild,
			{ via: [via], suggested: true },
			child,
		);
		await options.client.sendStateEvent(
			child,
			EventType.SpaceParent,
			{ via: [via], canonical: true },
			parent,
		);
	};
	const load = async () => {
		if (!loaded) {
			state = await options.store.load();
			if (
				state.identity &&
				(state.identity.bot !== options.bot || state.identity.homeserver !== options.homeserver)
			)
				state = emptyProjection();
			if (state.identity && state.identity.controller !== options.controller) {
				state.formerControllers = [
					...new Set([...(state.formerControllers ?? []), state.identity.controller]),
				].filter((controller) => controller !== options.controller);
			} else if (state.formerControllers?.includes(options.controller)) {
				state.formerControllers = state.formerControllers.filter(
					(controller) => controller !== options.controller,
				);
			}
			state.identity = {
				bot: options.bot,
				homeserver: options.homeserver,
				controller: options.controller,
			};
			for (const item of Object.values(state.inbox))
				if (item.phase === "dispatching") item.phase = "unknown";
			loaded = true;
			await save();
		}
	};

	const projection = {
		async *reconcileSteps() {
			assertActive();
			await load();
			diagnostic("reconcile-catalog");
			const generation = controlGeneration;
			targets = await options.host.catalog();
			yield;
			if (generation !== controlGeneration) return summary();
			diagnostic("reconcile-root");
			if (!state.rootRoomId) {
				if (state.rootCreating) throw new Error("Matrix room creation outcome is unknown");
				state.rootCreating = true;
				await save();
				state.rootRoomId = await makeRoom("OMT", true);
				delete state.rootCreating;
				await save();
			}
			await ensureSafe(state.rootRoomId);
			await configureRoomController(state.rootRoomId);
			yield;
			if (generation !== controlGeneration) return summary();
			diagnostic("reconcile-control");
			if (!state.controlRoomId) {
				if (state.controlCreating)
					throw new Error("Matrix control room creation outcome is unknown");
				state.controlCreating = true;
				await save();
				state.controlRoomId = await makeRoom("Control center", false);
				delete state.controlCreating;
				await save();
			}
			await ensureSafe(state.controlRoomId);
			await configureRoomController(state.controlRoomId);
			await link(state.rootRoomId, state.controlRoomId);
			yield;
			if (generation !== controlGeneration) return summary();
			const configuredProjects = new Set<string>();
			for (const target of targets) {
				assertActive();
				let mapping = state.sessions[target.sessionId];
				if (
					!mapping &&
					target.state.execution !== "running" &&
					!target.state.needsInput &&
					!target.state.backgroundWork &&
					!state.explicitSessionIds?.includes(target.sessionId)
				)
					continue;
				const project = state.projects[target.projectId] ?? {};
				state.projects[target.projectId] = project;
				if (!project.roomId) {
					if (project.creating) throw new Error("Matrix project creation outcome is unknown");
					project.creating = true;
					await save();
					project.roomId = await makeRoom(target.projectName, true);
					delete project.creating;
					await save();
				}
				if (!configuredProjects.has(target.projectId)) {
					diagnostic("reconcile-project");
					await ensureSafe(project.roomId);
					await link(state.rootRoomId, project.roomId);
					await options.client.setRoomName(project.roomId, target.projectName);
					await configureRoomController(project.roomId);
					configuredProjects.add(target.projectId);
					yield;
					if (generation !== controlGeneration) return summary();
				}
				if (!mapping) {
					mapping = {
						historyFormat: "markdown-v1",
						projectId: target.projectId,
						workspaceId: target.workspaceId,
						sessionId: target.sessionId,
						sent: [],
					};
					state.sessions[target.sessionId] = mapping;
				}
				diagnostic("reconcile-session");
				if (mapping.workspaceId !== target.workspaceId || mapping.projectId !== target.projectId)
					throw new Error("Matrix session ownership changed");
				if (!mapping.roomId) {
					if (mapping.creating) throw new Error("Matrix session creation outcome is unknown");
					mapping.creating = true;
					await save();
					mapping.roomId = await makeRoom(
						target.title || "Chat",
						false,
						`${target.projectName} / ${target.workspaceName} / ${target.sessionId}`,
					);
					delete mapping.creating;
					await save();
				}
				await ensureSafe(mapping.roomId);
				await link(project.roomId, mapping.roomId);
				await options.client.setRoomName(mapping.roomId, target.title || "Chat");
				await configureRoomController(mapping.roomId);
				if (target.state.needsInput) {
					const description = await options.host.interaction(target);
					const key = `interaction:${target.state.needsInput.interactionId}`;
					if (description && !mapping.sent.includes(key)) {
						await send(mapping.roomId, description, `${target.sessionId}:${key}`);
						mapping.sent.push(key);
						await save();
					}
				}
				yield;
				if (generation !== controlGeneration) return summary();
				diagnostic("reconcile-transcript");
				const transcript = await options.host.transcript(target);
				yield;
				if (generation !== controlGeneration) return summary();
				diagnostic("reconcile-output");
				// A running host may still be appending/streaming this message. Only project a
				// settled transcript so partial assistant output is never emitted.
				const occurrences = new Map<number, number>();
				if (target.state.execution !== "running")
					for (const message of transcript) {
						// Only assistant messages participate in stream identities. Users may
						// legitimately share their millisecond timestamp with an assistant.
						let messageKey: string | undefined;
						if (
							message &&
							typeof message === "object" &&
							"role" in message &&
							message.role === "assistant" &&
							"timestamp" in message &&
							typeof message.timestamp === "number" &&
							Number.isFinite(message.timestamp)
						) {
							const occurrence = occurrences.get(message.timestamp) ?? 0;
							occurrences.set(message.timestamp, occurrence + 1);
							messageKey = assistantMessageKey(message.timestamp, occurrence);
						}
						const text = transcriptProjection(message);
						if (!text) continue;
						if (messageKey !== undefined) {
							await projection.stream(target.sessionId, messageKey, message, true);
							yield;
							if (generation !== controlGeneration) return summary();
							continue;
						}
						const hash = createHash("sha256").update(text).digest("hex");
						if (mapping.sent.includes(hash)) continue;
						const chunkSize =
							mapping.historyFormat === "markdown-v1"
								? Math.floor(MATRIX_STREAM_CHUNK_MAX_BYTES / 4)
								: 12_000;
						for (let offset = 0; offset < text.length; offset += chunkSize) {
							const chunk = text.slice(offset, offset + chunkSize);
							const prefix = offset === 0 ? (/^(Assistant|User): /.exec(chunk)?.[0] ?? "") : "";
							await send(
								mapping.roomId,
								chunk,
								`${target.sessionId}:${hash}:${offset}`,
								mapping.historyFormat === "markdown-v1" && !isMarkdownContinuation(text, offset),
								mapping.historyFormat === "markdown-v1" ? prefix : "",
							);
							yield;
							if (generation !== controlGeneration) return summary();
						}
						mapping.sent.push(hash);
						await save();
					}
				const completion = target.state.completion;
				if (completion && target.state.execution === "idle" && !target.state.backgroundWork) {
					const key = `completion:${completion.completionId}`;
					if (!mapping.sent.includes(key)) {
						await send(
							mapping.roomId,
							`ThinkRail session settled: ${completion.outcome}.`,
							`${target.sessionId}:${key}`,
						);
						mapping.sent.push(key);
						await save();
					}
				}
				yield;
				if (generation !== controlGeneration) return summary();
			}
			return summary();
		},

		/** Caller coalesces partial snapshots (~1s). messageKey is assistantMessageKey(timestamp, transcript occurrence).
		 * Reconcile must have mapped the session first; stream never creates rooms or dispatches input.
		 */
		async stream(sessionId: string, messageKey: string, message: unknown, final: boolean) {
			assertActive();
			await load();
			const mapping = state.sessions[sessionId];
			if (!mapping?.roomId) return;
			const roomId = mapping.roomId;
			if (
				!message ||
				typeof message !== "object" ||
				!("role" in message) ||
				message.role !== "assistant"
			)
				return;
			if (
				!("timestamp" in message) ||
				typeof message.timestamp !== "number" ||
				!Number.isFinite(message.timestamp)
			)
				return;
			const timestampKey = String(message.timestamp);
			const suffix = messageKey.slice(timestampKey.length + 1);
			if (
				messageKey !== timestampKey &&
				(!messageKey.startsWith(`${timestampKey}:`) || !/^[1-9][0-9]*$/.test(suffix))
			)
				return;
			const text = transcriptProjection(message);
			if (!text) return;
			const key = projectionTransactionId(`${sessionId}:${messageKey}`);
			const existingReceipt = mapping.streams?.[key];
			if (
				existingReceipt &&
				!existingReceipt.pending &&
				(existingReceipt.final || (existingReceipt.text === text && !final))
			)
				return;
			const validate = async () => {
				assertActive();
				const fresh = (await options.host.catalog()).find((row) => row.sessionId === sessionId);
				if (!fresh) return false;
				if (fresh.projectId !== mapping.projectId || fresh.workspaceId !== mapping.workspaceId)
					throw new Error("Matrix session ownership changed");
				await ensureSafe(roomId);
				assertActive();
				return true;
			};
			if (!(await validate())) return;
			mapping.streams ??= {};
			mapping.streams[key] ??= {
				chunks: [],
				chunkSize: Math.floor(MATRIX_STREAM_CHUNK_MAX_BYTES / 4),
			};
			const receipt = mapping.streams[key];
			const deliver = async () => {
				const pending = receipt.pending;
				if (!pending) return true;
				const effectiveChunkSize = receipt.chunkSize ?? 12_000;
				receipt.chunkSize = effectiveChunkSize;
				const count = Math.max(
					receipt.chunks.length,
					Math.ceil(pending.text.length / effectiveChunkSize),
				);
				for (let i = 0; i < count; i++) {
					receipt.chunks[i] ??= { revision: 0 };
					const chunk = receipt.chunks[i];
					if (!chunk) throw new Error("Missing stream chunk receipt");
					const body = pending.text.slice(i * effectiveChunkSize, (i + 1) * effectiveChunkSize);
					const markdownOffset = i * effectiveChunkSize;
					if (chunk.text === body && chunk.pending === undefined) continue;
					const hadPendingPayload = chunk.pending !== undefined;

					if (!(await validate())) return false;
					const payload = chunk.pending ?? body;
					const prefix = i === 0 && payload.startsWith("Assistant: ") ? "Assistant: " : "";
					const markdown = prefix ? payload.slice(prefix.length) : payload;
					const rendered: Awaited<ReturnType<typeof matrixFormattedContent>> =
						await matrixFormattedContent(prefix, markdown, {
							allowFormatted:
								!hadPendingPayload &&
								!(i > 0 && isMarkdownContinuation(pending.text, markdownOffset)),
						});
					const replacement = rendered.formatted_body
						? {
								...ContentHelpers.makeNotice(rendered.body),
								format: "org.matrix.custom.html" as const,
								formatted_body: rendered.formatted_body,
							}
						: ContentHelpers.makeNotice(rendered.body);
					if (!chunk.pendingContent) {
						const candidate = chunk.eventId
							? {
									...replacement,
									"m.new_content": replacement,
									"m.relates_to": {
										rel_type: RelationType.Replace,
										event_id: chunk.eventId,
									},
								}
							: replacement;
						let content = candidate;
						if (Buffer.byteLength(JSON.stringify(candidate)) > MATRIX_EVENT_CONTENT_MAX_BYTES) {
							const plain = ContentHelpers.makeNotice(rendered.body);
							content = chunk.eventId
								? {
										...plain,
										"m.new_content": plain,
										"m.relates_to": {
											rel_type: RelationType.Replace,
											event_id: chunk.eventId,
										},
									}
								: plain;
						}
						if (
							!hadPendingPayload &&
							Buffer.byteLength(JSON.stringify(content)) > MATRIX_EVENT_CONTENT_MAX_BYTES
						)
							throw new Error("Matrix event content exceeds size limit");
						chunk.pending = payload;
						chunk.pendingContent = content;
						await save();
					}
					const sendContent = chunk.pendingContent;
					const result = await options.client.sendEvent(
						roomId,
						EventType.RoomMessage,
						sendContent as never,
						projectionTransactionId(`stream:${sessionId}:${messageKey}:${i}:${chunk.revision}`),
					);
					chunk.eventId ??= result.event_id;
					chunk.text = payload;
					delete chunk.pending;
					delete chunk.pendingContent;
					chunk.revision++;
					await save();
				}
				receipt.text = pending.text;
				receipt.final = pending.final;
				if (pending.final) {
					const hash = createHash("sha256").update(pending.text).digest("hex");
					if (!mapping.sent.includes(hash)) mapping.sent.push(hash);
				}
				delete receipt.pending;
				await save();
				return true;
			};
			// An uncertain response is retried with its original payload and transaction,
			// never with the newer snapshot under that transaction ID.
			if (receipt.pending && !(await deliver())) return;
			if (receipt.final || (receipt.text === text && !final)) return;
			receipt.chunkSize ??= 12_000;
			receipt.pending = { text, final };
			await save();
			await deliver();
		},

		async receive(event: {
			id: string;
			matrixEvent?: MatrixEvent;
			roomId: string;
			sender: string;
			text: string;
			historical: boolean;
			replacement: boolean;
		}) {
			assertActive();
			if (!loaded || event.sender !== options.controller || event.replacement) return;
			if (event.roomId === state.controlRoomId) {
				if (state.inbox[event.id]) {
					diagnostic("duplicate");
					return;
				}
				diagnostic("control-room");
				await ensureSafe(event.roomId);
				state.inbox[event.id] = { phase: "done", roomId: event.roomId };
				await save();
				if (event.historical) {
					diagnostic("historical");
					await send(
						event.roomId,
						"ThinkRail was offline; resend your directory command.",
						`offline:${event.id}`,
					);
					return;
				}
				const available = await options.host.catalog();
				if (event.text.startsWith("!omt attach ")) {
					const id = event.text.slice(12).trim();
					if (!available.some((target) => target.sessionId === id)) {
						await send(
							event.roomId,
							"Unknown or unavailable session ID.",
							`attach-error:${event.id}`,
						);
						return;
					}
					state.explicitSessionIds = [...new Set([...(state.explicitSessionIds ?? []), id])];
					await save();
					await send(
						event.roomId,
						"Session selected for mapping. Sync will create its room and backfill readable history.",
						`attach:${event.id}`,
					);
				} else {
					const directory = available
						.map(
							(target) =>
								`${target.projectName} / ${target.workspaceName} / ${target.title || "Chat"}\n${target.sessionId}${state.sessions[target.sessionId]?.roomId ? ` https://matrix.to/#/${state.sessions[target.sessionId]?.roomId}` : ""}`,
						)
						.join("\n\n");
					await send(
						event.roomId,
						`Use !omt sessions to list sessions; !omt attach <exact session ID> to map history.\n\n${directory.slice(0, 20000)}`,
						`directory:${event.id}`,
					);
				}
				return;
			}
			const mapping = Object.values(state.sessions).find((row) => row.roomId === event.roomId);
			if (!mapping) {
				diagnostic("unmapped-room");
				return;
			}
			if (state.inbox[event.id]) {
				diagnostic("duplicate");
				return;
			}
			if (event.historical) {
				diagnostic("historical");
				await ensureSafe(event.roomId);
				state.inbox[event.id] = { phase: "done", roomId: event.roomId };
				await save();
				await send(
					event.roomId,
					"ThinkRail was offline. This message was not executed; please resend it.",
					`offline:${event.id}`,
				);
				return;
			}
			const fresh = (await options.host.catalog()).find(
				(row) =>
					row.sessionId === mapping.sessionId &&
					row.workspaceId === mapping.workspaceId &&
					row.projectId === mapping.projectId,
			);
			if (!fresh) {
				diagnostic("not-available");
				await send(
					event.roomId,
					"This session is not available for Matrix control.",
					`unavailable:${event.id}`,
				);
				return;
			}
			await ensureSafe(event.roomId);
			if (!event.historical && event.matrixEvent) {
				try {
					await options.client.sendReadReceipt(event.matrixEvent, ReceiptType.Read);
				} catch {}
			}
			state.inbox[event.id] = { phase: "dispatching", roomId: event.roomId };
			await save();
			assertActive();
			const { parseMatrixCommand } = await import("./bridge");
			const command = parseMatrixCommand(event.text);
			diagnostic("dispatch-started");
			if (
				command.kind === "prompt" ||
				command.kind === "followup" ||
				command.kind === "answer" ||
				(command.kind === "stop" && fresh.state.runId)
			)
				controlGeneration++;
			try {
				if (command.kind === "prompt" || command.kind === "followup")
					await options.host.prompt(fresh, command.text, command.kind === "followup");
				else if (command.kind === "answer")
					await options.host.answer(fresh, command.interactionId, command.text);
				else if (command.kind === "stop" && fresh.state.runId)
					await options.host.stop(fresh, fresh.state.runId);
				else
					await send(
						event.roomId,
						command.kind === "status"
							? JSON.stringify(fresh.state)
							: "Commands: !omt status, !omt stop, !omt followup <text>, !omt say <text>. Unknown commands are not executed.",
						`command:${event.id}`,
					);
				state.inbox[event.id] = { phase: "done", roomId: event.roomId };
				await save();
				diagnostic("dispatch-accepted");
			} catch {
				diagnostic("dispatch-unknown");
				state.inbox[event.id] = { phase: "unknown", roomId: event.roomId };
				await save();
				await send(
					event.roomId,
					"Delivery outcome is unknown. Inspect the ThinkRail transcript before sending again.",
					`unknown:${event.id}`,
				);
			}
		},
	};

	// Serialize reconciliation, streaming snapshots and inbox writes against one durable state.
	let queue: Promise<unknown> = Promise.resolve();
	const serial =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		(...args: A): Promise<R> => {
			const result = queue.then(() => fn(...args));
			queue = result.catch(() => {});
			return result;
		};
	// Each generator advance owns state exclusively. Yield only after awaited work has
	// settled; queued live input runs before the next advance, never alongside it.
	let reconciling:
		| Promise<{ projects: number; sessions: number; backfilled: number; pendingControls: number }>
		| undefined;
	const reconcile = () => {
		if (reconciling) return reconciling;
		const steps = projection.reconcileSteps();
		const advance = serial(() => steps.next());
		reconciling = (async () => {
			for (;;) {
				const step = await advance();
				if (step.done) return step.value;
			}
		})().finally(() => {
			reconciling = undefined;
		});
		return reconciling;
	};
	return {
		reconcile,
		stream: serial(projection.stream),
		receive: serial(projection.receive),
	};
}
