import { expect, test } from "bun:test";
import type { MatrixClient } from "matrix-js-sdk";
import { createMatrixProjection, emptyProjection, type MatrixSessionTarget } from "./projection";

function fixture(hooks: { prompt?: () => void; diagnostic?: (code: string) => void } = {}) {
	let saved = emptyProjection();
	let allowed = true;
	let safe = true;
	let encrypted = false;
	let available = true;
	let lose = false;
	let serial = 0;
	let catalogCalls = 0;
	let roomStateCalls = 0;
	const target: MatrixSessionTarget = {
		projectId: "p",
		projectName: "P",
		workspaceId: "w",
		workspaceName: "W",
		sessionId: "s",
		title: "S",
		state: {
			execution: "running",
			runId: "r",
			needsInput: null,
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
	};
	const message = (text: string) => ({
		role: "assistant",
		timestamp: 1730000000000,
		content: [
			{ type: "thinking", thinking: "SECRET" },
			{ type: "text", text },
			{ type: "toolCall", name: "shell", arguments: { command: "SECRET" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "stop",
	});
	let history: unknown[] = [];
	const sends: {
		content: {
			msgtype?: string;
			body: string;
			"m.new_content"?: { body: string };
			"m.relates_to"?: { event_id: string; rel_type: string };
		};
		txn: string;
	}[] = [];
	const client = {
		async createRoom() {
			return { room_id: `!${++serial}` };
		},
		async roomState() {
			roomStateCalls++;
			return [
				{ type: "m.room.join_rules", content: { join_rule: safe ? "invite" : "public" } },
				...(encrypted ? [{ type: "m.room.encryption" }] : []),
			];
		},
		async invite() {},
		async sendStateEvent() {},
		async setRoomName() {},
		async sendEvent(
			_room: string,
			_type: string,
			content: (typeof sends)[number]["content"],
			txn: string,
		) {
			sends.push({ content, txn });
			if (lose) {
				lose = false;
				throw new Error("lost");
			}
			return { event_id: `$${txn}` };
		},
	} as unknown as MatrixClient;
	const make = () =>
		createMatrixProjection({
			...(hooks.diagnostic ? { diagnostic: hooks.diagnostic } : {}),
			client,
			controller: "@c:example.org",
			bot: "@b:example.org",
			homeserver: "https://example.org",
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
					catalogCalls++;
					return available ? [structuredClone(target)] : [];
				},
				async transcript() {
					return history;
				},
				async prompt() {
					if (hooks.prompt) hooks.prompt();
					else throw new Error("must not replay input");
				},
				async stop() {},
				async answer() {},
				async interaction() {
					return null;
				},
			},
		});
	return {
		make,
		message,
		sends,
		target,
		history: (value: unknown[]) => {
			history = value;
		},
		allowed: () => {
			allowed = false;
		},
		unsafe: () => {
			safe = false;
		},
		encrypt: () => {
			encrypted = true;
		},
		unavailable: () => {
			available = false;
		},
		state: () => saved,
		catalogCalls: () => catalogCalls,
		roomStateCalls: () => roomStateCalls,
		lose: () => {
			lose = true;
		},
	};
}

test("first partial -> replacement -> final -> settled history has no duplicate", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("Hi"), false);
	await p.stream("s", "1730000000000", f.message("Hi there"), false);
	await p.stream("s", "1730000000000", f.message("Hi there!"), true);
	expect(f.sends).toHaveLength(3);
	expect(f.sends[0]?.content).toEqual({ msgtype: "m.notice", body: "Assistant: Hi" });
	for (const send of f.sends.slice(1))
		expect(send.content["m.relates_to"]).toEqual({
			rel_type: "m.replace",
			event_id: `$${f.sends[0]?.txn}`,
		});
	expect(f.sends[2]?.content["m.new_content"]?.body).toBe("Assistant: Hi there!");
	expect(JSON.stringify(f.sends)).not.toContain("SECRET");
	f.history([f.message("Hi there!")]);
	f.target.state.execution = "idle";
	await p.reconcile();
	expect(f.sends).toHaveLength(3);
});

test("settled repeated final history avoids per-message authority catalog checks", async () => {
	const f = fixture();
	f.history(
		Array.from({ length: 5 }, (_, i) => ({ ...f.message(`M${i}`), timestamp: 1730000000000 + i })),
	);
	f.target.state.execution = "idle";
	f.target.state.backgroundWork = true;
	const p = f.make();
	await p.reconcile();
	const callsAfterFirst = f.catalogCalls();
	await p.reconcile();
	expect(f.catalogCalls()).toBe(callsAfterFirst + 1);
	expect(f.sends).toHaveLength(5);
});

test("restart retries unknown original and edit with stable transactions before newer text", async () => {
	const f = fixture();
	let p = f.make();
	await p.reconcile();
	f.lose();
	await expect(p.stream("s", "1730000000000", f.message("A"), false)).rejects.toThrow("lost");
	p = f.make();
	await p.stream("s", "1730000000000", f.message("AB"), false);
	expect(f.sends[0]?.txn).toBe(f.sends[1]?.txn);
	expect(f.sends[1]?.content.body).toBe("Assistant: A");
	f.lose();
	await expect(p.stream("s", "1730000000000", f.message("ABC"), false)).rejects.toThrow("lost");
	const lost = f.sends.at(-1);
	if (!lost) throw new Error("Expected lost send");
	p = f.make();
	await p.stream("s", "1730000000000", f.message("ABCD"), true);
	expect(f.sends.findLast((s) => s.txn === lost.txn)?.content).toEqual(lost.content);
	expect(f.sends.at(-1)?.content["m.relates_to"]?.event_id).toBe(`$${f.sends[0]?.txn}`);
});

test("stream checks current ownership, allowed and private unencrypted room", async () => {
	for (const change of ["allowed", "unsafe", "encrypt", "unavailable"] as const) {
		const f = fixture();
		const p = f.make();
		await p.reconcile();
		f[change]();
		try {
			await p.stream("s", "1730000000000", f.message("private"), false);
		} catch {}
		expect(f.sends).toHaveLength(0);
	}
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	f.target.workspaceId = "other";
	await expect(p.stream("s", "1730000000000", f.message("private"), false)).rejects.toThrow(
		"ownership",
	);
	expect(f.sends).toHaveLength(0);
});

test("long streaming text uses bounded chunks with stable original identities", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("x".repeat(24000)), false);
	expect(f.sends).toHaveLength(3);
	await p.stream("s", "1730000000000", f.message("y".repeat(24000)), true);
	for (const send of f.sends) expect(send.content.body.length).toBeLessThanOrEqual(12000);
	expect(f.sends.slice(3).map((s) => s.content["m.relates_to"]?.event_id)).toEqual(
		f.sends.slice(0, 3).map((s) => `$${s.txn}`),
	);
});

test("settled reconciliation finalizes a streamed message after a missed final event", async () => {
	const f = fixture();
	let p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("Partial"), false);
	f.history([f.message("Finished")]);
	f.target.state.execution = "idle";
	p = f.make();
	await p.reconcile();
	await p.reconcile();
	expect(f.sends).toHaveLength(2);
	expect(f.sends[1]?.content["m.new_content"]?.body).toBe("Assistant: Finished");
	expect(f.sends[1]?.content["m.relates_to"]?.event_id).toBe(`$${f.sends[0]?.txn}`);
});

test("unchanged final records completion without an edit and concurrent snapshots serialize", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	await Promise.all([
		p.stream("s", "1730000000000", f.message("A"), false),
		p.stream("s", "1730000000000", f.message("AB"), false),
	]);
	await p.stream("s", "1730000000000", f.message("AB"), true);
	expect(
		Object.values(f.state().sessions.s?.streams ?? {}).map((receipt) => receipt.final),
	).toEqual([true]);
	expect(f.state().sessions.s?.sent).toHaveLength(1);
	f.history([f.message("AB")]);
	f.target.state.execution = "idle";
	await p.reconcile();
	expect(f.sends).toHaveLength(2);
	expect(new Set(f.sends.map((s) => s.txn)).size).toBe(2);
});

test("stream ignores non-assistant, timestamp mismatch and non-text blocks", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	const catalogCalls = f.catalogCalls();
	const roomStateCalls = f.roomStateCalls();
	for (const message of [
		{ ...f.message("User"), role: "user" },
		{ ...f.message("Mismatch"), timestamp: 1 },
		{
			...f.message(""),
			content: [
				{ type: "thinking", thinking: "secret" },
				{ type: "toolResult", text: "secret" },
			],
		},
	]) {
		await p.stream("s", "1730000000000", message, false);
	}
	expect(f.sends).toHaveLength(0);
	expect(f.catalogCalls()).toBe(catalogCalls);
	expect(f.roomStateCalls()).toBe(roomStateCalls);
});

test("user sharing an assistant timestamp is preserved without finalizing its stream", async () => {
	const f = fixture();
	let p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("Partial"), false);
	f.history([
		{ role: "user", timestamp: 1730000000000, content: [{ type: "text", text: "Question" }] },
		f.message("Finished"),
	]);
	f.target.state.execution = "idle";
	p = f.make();
	await p.reconcile();
	await p.reconcile();
	expect(f.sends.map((s) => s.content.body)).toEqual([
		"Assistant: Partial",
		"User: Question",
		"Assistant: Finished",
	]);
	expect(f.sends[1]?.content["m.relates_to"]).toBeUndefined();
	expect(f.sends[2]?.content["m.relates_to"]?.event_id).toBe(`$${f.sends[0]?.txn}`);
});

test("same-millisecond assistants retain distinct immutable identities across restart and history", async () => {
	const f = fixture();
	let p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("First"), true);
	await p.stream("s", "1730000000000:1", f.message("Second partial"), false);
	f.history([f.message("First"), f.message("Second")]);
	f.target.state.execution = "idle";
	p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000:1", f.message("late mutation"), true);
	await p.reconcile();
	expect(f.sends.map((s) => s.content.body)).toEqual([
		"Assistant: First",
		"Assistant: Second partial",
		"Assistant: Second",
	]);
	expect(f.sends[1]?.content["m.relates_to"]).toBeUndefined();
	expect(f.sends[2]?.content["m.relates_to"]?.event_id).toBe(`$${f.sends[1]?.txn}`);
	expect(new Set(f.sends.map((s) => s.txn)).size).toBe(3);
});

test("history-only assistants with identical timestamp and text do not collapse", async () => {
	const f = fixture();
	f.history([f.message("Same"), f.message("Same")]);
	f.target.state.backgroundWork = true;
	f.target.state.execution = "idle";
	await f.make().reconcile();
	await f.make().reconcile();
	expect(f.sends.map((s) => s.content.body)).toEqual(["Assistant: Same", "Assistant: Same"]);
	expect(new Set(f.sends.map((s) => s.txn)).size).toBe(2);
});

for (const checkpoint of ["reconcile-session", "reconcile-transcript", "reconcile-output"]) {
	test(`inbound prompt at ${checkpoint} invalidates settled output until a fresh pass`, async () => {
		let armed = false;
		let receive: Promise<void> | undefined;
		const f = fixture({
			prompt: () => {
				f.target.state = { ...f.target.state, execution: "running", completion: null };
				f.history([f.message("New partial")]);
			},
			diagnostic: (code) => {
				if (!armed || code !== checkpoint) return;
				armed = false;
				const roomId = f.state().sessions.s?.roomId;
				if (!roomId) throw new Error("Expected mapped room");
				receive = p.receive({
					id: "$interleaved",
					roomId,
					sender: "@c:example.org",
					text: "next turn",
					historical: false,
					replacement: false,
				});
			},
		});
		const p = f.make();
		await p.reconcile();
		f.target.state.execution = "idle";
		f.target.state.completion = { completionId: "old", outcome: "succeeded" };
		// Output checkpoint queues the command during the first history message; the
		// next checkpoint must suppress the remaining history and completion notice.
		f.history(
			checkpoint === "reconcile-output"
				? [f.message("Old output"), { ...f.message("Stale output"), timestamp: 1730000000001 }]
				: [],
		);
		armed = true;
		await p.reconcile();
		expect(receive).toBeDefined();
		await receive;
		expect(f.sends.map((send) => send.content.body)).toEqual(
			checkpoint === "reconcile-output" ? ["Assistant: Old output"] : [],
		);
		expect(
			Object.values(f.state().sessions.s?.streams ?? {}).some(
				(row) => row.text === "Assistant: New partial" && row.final,
			),
		).toBe(false);
		await p.reconcile();
		const timestamp = checkpoint === "reconcile-output" ? 1730000000002 : 1730000000000;
		const message = (text: string) => ({ ...f.message(text), timestamp });
		await p.stream("s", String(timestamp), message("New partial grows"), false);
		await p.stream("s", String(timestamp), message("New complete"), true);
		expect(f.sends.at(-1)?.content.body).toBe("Assistant: New complete");
		expect(f.sends.at(-1)?.content["m.relates_to"]?.event_id).toBe(`$${f.sends.at(-2)?.txn}`);
	});
}
