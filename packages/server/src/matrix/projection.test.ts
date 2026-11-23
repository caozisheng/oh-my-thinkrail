import { expect, test } from "bun:test";
import type { MatrixClient } from "matrix-js-sdk";
import {
	createMatrixProjection,
	emptyProjection,
	type MatrixProjectionState,
	type MatrixSessionTarget,
} from "./projection";

const target: MatrixSessionTarget = {
	projectId: "p1",
	projectName: "Project",
	workspaceId: "w1",
	workspaceName: "Workspace",
	sessionId: "s1",
	title: "Session",
	state: {
		execution: "running",
		runId: "r1",
		needsInput: null,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	},
};
function fixture() {
	let saved = emptyProjection();
	saved.explicitSessionIds = ["s1"];
	const current = structuredClone(target);
	let serial = 0;
	const sent: string[] = [];
	const txids: string[] = [];
	let encrypted = false;
	let loseCreateRoomResponse = false;
	let loseSendResponse = false;
	const prompts: string[] = [];
	const calls: Record<string, unknown>[] = [];
	const powerLevels: { roomId: string; userId: string; level: number | undefined }[] = [];
	const invites: { roomId: string; userId: string }[] = [];
	let allowed = true;
	const client = {
		async createRoom(input: Record<string, unknown>) {
			calls.push(input);
			const room_id = `!room${++serial}:example.org`;
			if (loseCreateRoomResponse) {
				loseCreateRoomResponse = false;
				throw new Error("createRoom response lost");
			}
			return { room_id };
		},
		async roomState() {
			return encrypted
				? [
						{ type: "m.room.join_rules", content: { join_rule: "invite" } },
						{ type: "m.room.encryption", content: {} },
					]
				: [{ type: "m.room.join_rules", content: { join_rule: "invite" } }];
		},
		async invite(roomId: string, userId: string) {
			invites.push({ roomId, userId });
		},
		async sendStateEvent() {},
		async setRoomName() {},
		async setPowerLevel(roomId: string, userId: string, level: number | undefined) {
			powerLevels.push({ roomId, userId, level });
		},
		async sendEvent(_room: string, _type: string, content: { body: string }, txid: string) {
			txids.push(txid);
			sent.push(content.body);
			if (loseSendResponse) {
				loseSendResponse = false;
				throw new Error("sendEvent response lost");
			}
			return { event_id: `$${sent.length}` };
		},
	} as unknown as MatrixClient;
	const make = () =>
		createMatrixProjection({
			client,
			controller: "@owner:example.org",
			bot: "@bot:example.org",
			homeserver: "https://matrix.example.org",
			allowed: () => allowed,
			store: {
				async load() {
					return structuredClone(saved);
				},
				async save(state) {
					saved = structuredClone(state);
				},
			},
			host: {
				async catalog() {
					return [current];
				},
				async transcript() {
					return [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }];
				},
				async prompt(_target, text) {
					prompts.push(text);
				},
				async stop() {},
				async interaction() {
					return null;
				},
				async answer() {},
			},
		});
	return {
		make,
		current,
		sent,
		prompts,
		calls,
		txids,
		setEncrypted: (value: boolean) => {
			encrypted = value;
		},
		loseNextCreateRoomResponse: () => {
			loseCreateRoomResponse = true;
		},
		loseNextSendResponse: () => {
			loseSendResponse = true;
		},
		powerLevels,
		invites,
		state: (): MatrixProjectionState => saved,
		stop: () => {
			allowed = false;
		},
	};
}

test("creates private OMT/project/session rooms once and reuses mappings across restart", async () => {
	const f = fixture();
	await f.make().reconcile();
	expect(f.calls.map((call) => call.name)).toEqual(["OMT", "Control center", "Project", "Session"]);
	expect(f.calls.every((call) => call.visibility === "private")).toBe(true);
	expect(f.sent).toEqual([]);
	expect(f.powerLevels).toEqual([
		{ roomId: "!room1:example.org", userId: "@owner:example.org", level: 10 },
		{ roomId: "!room2:example.org", userId: "@owner:example.org", level: 10 },
		{ roomId: "!room3:example.org", userId: "@owner:example.org", level: 10 },
		{ roomId: "!room4:example.org", userId: "@owner:example.org", level: 10 },
	]);
	await f.make().reconcile();
	expect(f.calls).toHaveLength(4);
	expect(f.sent).toHaveLength(0);
});

test("unknown createRoom response is not retried after restart", async () => {
	const f = fixture();
	f.loseNextCreateRoomResponse();
	await expect(f.make().reconcile()).rejects.toThrow("createRoom response lost");
	expect(f.calls).toHaveLength(1);
	expect(f.state().rootCreating).toBe(true);
	expect(f.state().rootRoomId).toBeUndefined();
	await expect(f.make().reconcile()).rejects.toThrow("outcome is unknown");
	expect(f.calls).toHaveLength(1);
});

test("lost output send response reuses the exact transaction ID after restart", async () => {
	const f = fixture();
	f.current.state = { ...target.state, execution: "idle" };
	f.loseNextSendResponse();
	await expect(f.make().reconcile()).rejects.toThrow("sendEvent response lost");
	const txid = f.txids.at(-1);
	if (!txid) throw new Error("Expected output transaction ID");
	expect(f.sent).toEqual(["Assistant: Hello"]);
	expect(f.state().sessions.s1?.sent).toEqual([]);
	await f.make().reconcile();
	expect(f.txids).toEqual([txid, txid]);
	expect(f.sent).toEqual(["Assistant: Hello", "Assistant: Hello"]);
	expect(f.state().sessions.s1?.sent).toHaveLength(1);
	await f.make().reconcile();
	expect(f.txids).toEqual([txid, txid]);
});

test("unfinished durable dispatches become unknown and are not replayed after restart", async () => {
	const f = fixture();
	await f.make().reconcile();
	const roomId = f.state().sessions.s1?.roomId;
	if (!roomId) throw new Error("Expected mapped room");
	const state = f.state();
	state.inbox.$pending = { phase: "dispatching", roomId };
	await f.make().reconcile();
	expect(f.state().inbox.$pending?.phase).toBe("unknown");
	expect(f.prompts).toEqual([]);
});

test("control center attach maps only exact available session IDs without prompting", async () => {
	const f = fixture();
	f.state().explicitSessionIds = [];
	f.current.state = { ...target.state, execution: "idle" };
	const bridge = f.make();
	await bridge.reconcile();
	const controlRoomId = f.state().controlRoomId;
	if (!controlRoomId) throw new Error("Expected control room");
	expect(f.state().sessions).toEqual({});
	for (const id of ["s", "s1-extra", "Session", "unavailable"]) {
		await bridge.receive({
			id: `$invalid-${id}`,
			roomId: controlRoomId,
			sender: "@owner:example.org",
			text: `!omt attach ${id}`,
			historical: false,
			replacement: false,
		});
	}
	await bridge.reconcile();
	expect(f.state().explicitSessionIds).toEqual([]);
	expect(f.state().sessions).toEqual({});
	expect(f.sent).toEqual(Array(4).fill("Unknown or unavailable session ID."));
	await bridge.receive({
		id: "$attach",
		roomId: controlRoomId,
		sender: "@owner:example.org",
		text: "!omt attach s1",
		historical: false,
		replacement: false,
	});
	expect(f.state().explicitSessionIds).toEqual(["s1"]);
	await f.make().reconcile();
	expect(f.state().sessions.s1?.roomId).toBeDefined();
	expect(Object.keys(f.state().sessions)).toEqual(["s1"]);
	expect(f.sent.at(-1)).toBe("Assistant: Hello");
	expect(f.prompts).toEqual([]);
});

test("historical notices validate room safety before sending", async () => {
	const f = fixture();
	const bridge = f.make();
	await bridge.reconcile();
	const roomId = f.state().sessions.s1?.roomId;
	if (!roomId) throw new Error("Expected mapped room");
	f.setEncrypted(true);
	await expect(
		bridge.receive({
			id: "$historical",
			roomId,
			sender: "@owner:example.org",
			text: "hello",
			historical: true,
			replacement: false,
		}),
	).rejects.toThrow("Encrypted");
	expect(f.sent).toEqual([]);
});

test("running transcripts are not projected until execution settles", async () => {
	const f = fixture();
	const mutable = f.current;
	mutable.state = { ...target.state, execution: "running" };
	await f.make().reconcile();
	expect(f.sent).toEqual([]);
	mutable.state = { ...target.state, execution: "idle" };
	await f.make().reconcile();
	expect(f.sent).toEqual(["Assistant: Hello"]);
});

test("controller changes invite the new controller and downgrade the previous one", async () => {
	const f = fixture();
	await f.make().reconcile();
	f.powerLevels.length = 0;
	const state = f.state();
	if (!state.rootRoomId) throw new Error("Expected root mapping");
	state.identity = {
		bot: "@bot:example.org",
		homeserver: "https://matrix.example.org",
		controller: "@old:example.org",
	};
	await f.make().reconcile();
	expect(f.invites.every((invite) => invite.userId === "@owner:example.org")).toBe(true);
	expect(
		f.powerLevels
			.filter((entry) => entry.userId === "@old:example.org")
			.every((entry) => entry.level === 0),
	).toBe(true);
});

test("a controller that is re-authorized is not left in the former-controller downgrade set", async () => {
	const f = fixture();
	await f.make().reconcile();
	const state = f.state();
	state.identity = {
		bot: "@bot:example.org",
		homeserver: "https://matrix.example.org",
		controller: "@old:example.org",
	};
	state.formerControllers = ["@owner:example.org"];
	await f.make().reconcile();
	expect(
		f.powerLevels
			.filter((entry) => entry.userId === "@owner:example.org")
			.every((entry) => entry.level === 10),
	).toBe(true);
});

test("only live controller input is dispatched once; historical and edited input never executes", async () => {
	const f = fixture();
	const bridge = f.make();
	await bridge.reconcile();
	const roomId = f.state().sessions.s1?.roomId;
	if (!roomId) throw new Error("Expected mapped room");
	const event = {
		id: "$1",
		roomId,
		sender: "@owner:example.org",
		text: "hello",
		historical: false,
		replacement: false,
	};
	await bridge.receive({ ...event, sender: "@other:example.org" });
	await bridge.receive({ ...event, id: "$old", historical: true });
	await bridge.receive({ ...event, id: "$edit", replacement: true });
	expect(f.prompts).toEqual([]);
	await bridge.receive(event);
	await bridge.receive(event);
	expect(f.prompts).toEqual(["hello"]);
	f.stop();
	await expect(bridge.receive({ ...event, id: "$stopped" })).rejects.toThrow();
});
