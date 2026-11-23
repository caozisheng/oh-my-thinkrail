import { createHash } from "node:crypto";
import type { SessionState } from "@thinkrail/contracts";
import { EventType, type MatrixClient, MsgType, Preset, RoomType, Visibility } from "matrix-js-sdk";
import { projectionTransactionId, transcriptProjection } from "./bridge";

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
	roomId?: string;
	creating?: true;
	projectId: string;
	workspaceId: string;
	sessionId: string;
	projectRoomId?: string;
	projectCreating?: true;
	sent: string[];
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
	client: MatrixClient;
	controller: string;
	bot: string;
	homeserver: string;
	host: MatrixHostPort;
	store: MatrixProjectionStore;
	allowed: () => boolean;
}) {
	let state = emptyProjection();
	let targets: MatrixSessionTarget[] = [];
	let loaded = false;
	const save = () => options.store.save(structuredClone(state));
	const assertActive = () => {
		if (!options.allowed()) throw new Error("Matrix integration stopped");
	};
	const send = async (roomId: string, text: string, key: string) => {
		assertActive();
		await ensureSafe(roomId);
		assertActive();
		await options.client.sendEvent(
			roomId,
			EventType.RoomMessage,
			{ msgtype: MsgType.Notice, body: text },
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
		await options.client.setPowerLevel(roomId, options.controller, 10);
		for (const former of state.formerControllers ?? [])
			if (former !== options.controller) await options.client.setPowerLevel(roomId, former, 0);
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
	return {
		async reconcile() {
			assertActive();
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
			targets = await options.host.catalog();
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
			for (const target of targets) {
				assertActive();
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
				await ensureSafe(project.roomId);
				await link(state.rootRoomId, project.roomId);
				await options.client.setRoomName(project.roomId, target.projectName);
				await configureRoomController(project.roomId);
				let mapping = state.sessions[target.sessionId];
				if (!mapping) {
					if (
						target.state.execution !== "running" &&
						!target.state.needsInput &&
						!target.state.backgroundWork &&
						!state.explicitSessionIds?.includes(target.sessionId)
					)
						continue;
					mapping = {
						projectId: target.projectId,
						workspaceId: target.workspaceId,
						sessionId: target.sessionId,
						sent: [],
					};
					state.sessions[target.sessionId] = mapping;
				}
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
				const transcript = await options.host.transcript(target);
				// A running host may still be appending/streaming this message. Only project a
				// settled transcript so partial assistant output is never emitted.
				if (target.state.execution !== "running")
					for (const message of transcript) {
						const text = transcriptProjection(message);
						if (!text) continue;
						const hash = createHash("sha256").update(text).digest("hex");
						if (mapping.sent.includes(hash)) continue;
						for (let offset = 0; offset < text.length; offset += 12000)
							await send(
								mapping.roomId,
								text.slice(offset, offset + 12000),
								`${target.sessionId}:${hash}:${offset}`,
							);
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
			}
			return {
				projects: Object.keys(state.projects).length,
				sessions: Object.keys(state.sessions).length,
				backfilled: Object.values(state.sessions).reduce((n, row) => n + row.sent.length, 0),
				pendingControls: Object.values(state.inbox).filter((row) => row.phase === "unknown").length,
			};
		},
		async receive(event: {
			id: string;
			roomId: string;
			sender: string;
			text: string;
			historical: boolean;
			replacement: boolean;
		}) {
			assertActive();
			if (!loaded || event.sender !== options.controller || event.replacement) return;
			if (event.roomId === state.controlRoomId) {
				if (state.inbox[event.id]) return;
				await ensureSafe(event.roomId);
				state.inbox[event.id] = { phase: "done", roomId: event.roomId };
				await save();
				if (event.historical) {
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
			if (!mapping || state.inbox[event.id]) return;
			if (event.historical) {
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
				await send(
					event.roomId,
					"This session is not available for Matrix control.",
					`unavailable:${event.id}`,
				);
				return;
			}
			await ensureSafe(event.roomId);
			state.inbox[event.id] = { phase: "dispatching", roomId: event.roomId };
			await save();
			assertActive();
			const { parseMatrixCommand } = await import("./bridge");
			const command = parseMatrixCommand(event.text);
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
			} catch {
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
}
