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
	let serial = 0;
	const sent: string[] = [];
	const prompts: string[] = [];
	const calls: Record<string, unknown>[] = [];
	const powerLevels: { roomId: string; userId: string; level: number | undefined }[] = [];
	const invites: { roomId: string; userId: string }[] = [];
	let allowed = true;
	const client = {
		async createRoom(input: Record<string, unknown>) {
			calls.push(input);
			return { room_id: `!room${++serial}:example.org` };
		},
		async roomState() {
			return [{ type: "m.room.join_rules", content: { join_rule: "invite" } }];
		},
		async invite(roomId: string, userId: string) {
			invites.push({ roomId, userId });
		},
		async sendStateEvent() {},
		async setRoomName() {},
		async setPowerLevel(roomId: string, userId: string, level: number | undefined) {
			powerLevels.push({ roomId, userId, level });
		},
		async sendEvent(_room: string, _type: string, content: { body: string }) {
			sent.push(content.body);
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
					return [target];
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
		sent,
		prompts,
		calls,
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
	expect(f.sent).toEqual(["Assistant: Hello"]);
	expect(f.powerLevels).toEqual([
		{ roomId: "!room1:example.org", userId: "@owner:example.org", level: 10 },
		{ roomId: "!room2:example.org", userId: "@owner:example.org", level: 10 },
		{ roomId: "!room3:example.org", userId: "@owner:example.org", level: 10 },
		{ roomId: "!room4:example.org", userId: "@owner:example.org", level: 10 },
	]);
	await f.make().reconcile();
	expect(f.calls).toHaveLength(4);
	expect(f.sent).toHaveLength(1);
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
