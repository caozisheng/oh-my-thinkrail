import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { MatrixClient } from "matrix-js-sdk";
import { isMarkdownContinuation, projectionTransactionId } from "./bridge";
import { createMatrixProjection, emptyProjection, type MatrixSessionTarget } from "./projection";

function fixture(
	hooks: {
		prompt?: () => void;
		diagnostic?: (code: string) => void;
		save?: (state: ReturnType<typeof emptyProjection>) => void;
	} = {},
) {
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
	const message = (text: string, type = "text") => ({
		role: "assistant",
		timestamp: 1730000000000,
		content: [
			{ type: "thinking", thinking: "SECRET" },
			{ type, text },
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
			format?: string;
			formatted_body?: string;
			"m.new_content"?: {
				msgtype?: string;
				body: string;
				format?: string;
				formatted_body?: string;
			};
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
			sends.push({ content: structuredClone(content), txn });
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
					hooks.save?.(structuredClone(saved));
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
		seed: (value: ReturnType<typeof emptyProjection>) => {
			saved = structuredClone(value);
		},
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

test("formatted streaming messages stay within the serialized Matrix event size budget", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	const ascii = "a".repeat(12_000);
	await p.stream("s", "1730000000000", f.message(ascii), false);
	await p.stream("s", "1730000000000", f.message("你".repeat(12_000)), true);
	for (const send of f.sends) {
		expect(Buffer.byteLength(JSON.stringify(send.content))).toBeLessThanOrEqual(60_000);
		if (send.content["m.new_content"])
			expect(Object.hasOwn(send.content["m.new_content"], "m.new_content")).toBe(false);
	}
	expect(f.sends.every((send) => send.content.format === "org.matrix.custom.html")).toBe(true);
});

test("formatted streaming messages carry a single m.new_content per replacement", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("**partial**"), false);
	await p.stream("s", "1730000000000", f.message("**final**"), true);
	const replacement = f.sends.at(-1)?.content;
	expect(replacement?.["m.new_content"]?.formatted_body).toContain("<strong>final</strong>");
});

test("legacy pending stream chunks retry the exact persisted payload and transaction", async () => {
	const f = fixture();
	const seeded = emptyProjection();
	seeded.sessions.s = {
		projectId: "p",
		workspaceId: "w",
		sessionId: "s",
		roomId: "!legacy",
		sent: [],
		streams: {
			[projectionTransactionId("s:1730000000000")]: {
				chunks: [
					{
						eventId: "$legacy",
						text: "",
						pending: `Assistant: ${"x".repeat(12_000)}`,
						revision: 0,
					},
				],
				chunkSize: 12_000,
				pending: { text: `Assistant: ${"x".repeat(12_000)}tail`, final: false },
			},
		},
	};
	f.seed(seeded);
	f.lose();
	const p = f.make();
	await expect(
		p.stream("s", "1730000000000", f.message(`${"x".repeat(12_000)}tail`), false),
	).rejects.toThrow("lost");
	expect(f.sends[0]?.content.body).toBe(`Assistant: ${"x".repeat(12_000)}`);
	expect(f.sends[0]?.txn).toBe(projectionTransactionId(`stream:s:1730000000000:0:0`));
});

test("markdown split inside a fenced code block falls back to text", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	const markdown = `\`\`\`text\n${"![image](url)\n".repeat(500)}`;
	await p.stream("s", "1730000000000", f.message(markdown), true);
	expect(f.sends.length).toBeGreaterThan(1);
	expect(f.sends.slice(1).every(({ content }) => content.formatted_body === undefined)).toBe(true);
});

test("fence continuation uses full projected offsets for assistant and user prefixes", async () => {
	for (const role of ["Assistant", "User"]) {
		const content = `${role}: \`\`\`ts\n${"x".repeat(2_480)}\n![literal](https://example.org/image)`;
		expect(isMarkdownContinuation(content, 2_500)).toBe(true);
	}
	const nearBoundary = `Assistant: \`\`\`ts\n${"x".repeat(2_479)}\n\`\`\`ts\n**literal**`;
	expect(isMarkdownContinuation(nearBoundary, 2_500)).toBe(true);
	expect(isMarkdownContinuation("Assistant: ```ts\ncode\n```ts", 25)).toBe(true);
	expect(isMarkdownContinuation("Assistant: ```ts\ncode\n```", 27)).toBe(false);
	expect(isMarkdownContinuation("User: ```ts\ncode\n```", 0)).toBe(false);
	expect(isMarkdownContinuation("User: ```ts\ncode\n```", 12)).toBe(true);
	const partialClosing = `Assistant: \`\`\`ts\n${"x".repeat(2_481)}\n\`\`\`\ntext`;
	expect(isMarkdownContinuation(partialClosing, 2_500)).toBe(true);
});

test("streaming Markdown headings and leading code fences retain their structure", async () => {
	for (const [text, expected] of [
		["# A heading", "<h1>A heading</h1>"],
		[`\`\`\`ts\nconst value = 1;\n\`\`\``, '<pre><code class="language-ts">const value = 1;'],
	] as const) {
		const f = fixture();
		const p = f.make();
		await p.reconcile();
		await p.stream("s", "1730000000000", f.message(text), false);
		expect(f.sends[0]?.content.formatted_body).toContain(expected);
	}
});

test("streaming message creates and replaces include formatted custom HTML content", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("**partial**"), false);
	await p.stream("s", "1730000000000", f.message("**finished**"), true);
	expect(f.sends).toHaveLength(2);
	for (const send of f.sends) {
		const content = send.content["m.new_content"] ?? send.content;
		expect(Buffer.byteLength(JSON.stringify(send.content))).toBeLessThanOrEqual(60_000);
		expect(content.format).toBe("org.matrix.custom.html");
		expect(content.formatted_body).toContain("<strong>");
	}
	expect(f.sends.at(-1)?.content["m.new_content"]?.formatted_body).toContain(
		"<strong>finished</strong>",
	);
});

test("empty and whitespace snapshots never create or replace Matrix messages", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	const empty = (text: string) => ({
		role: "assistant",
		timestamp: 1730000000000,
		content: [
			{ type: "text", text },
			{ type: "toolCall", name: "shell" },
		],
	});
	await p.stream("s", "1730000000000", empty(""), false);
	await p.stream("s", "1730000000000", empty("  \n "), false);
	expect(f.sends).toHaveLength(0);
	await p.stream("s", "1730000000000", f.message("Tool result is ready"), false);
	expect(f.sends).toHaveLength(1);
	expect(f.sends[0]?.content.body).toBe("Assistant: Tool result is ready");
});

test("first partial -> replacement -> final -> settled history has no duplicate", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("Hi"), false);
	await p.stream("s", "1730000000000", f.message("Hi there"), false);
	await p.stream("s", "1730000000000", f.message("Hi there!"), true);
	expect(f.sends).toHaveLength(3);
	expect(f.sends[0]?.content).toMatchObject({
		msgtype: "m.notice",
		body: "Assistant: Hi",
		format: "org.matrix.custom.html",
		formatted_body: "<p>Assistant: </p><p>Hi</p>",
	});
	expect(f.sends[0]?.content["m.new_content"]).toBeUndefined();
	for (const send of f.sends.slice(1)) {
		expect(send.content["m.new_content"]?.format).toBe("org.matrix.custom.html");
		expect(send.content["m.new_content"]?.formatted_body).toContain("<p>Assistant: </p><p>Hi");
		expect(send.content["m.relates_to"]).toEqual({
			rel_type: "m.replace",
			event_id: `$${f.sends[0]?.txn}`,
		});
	}
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
	expect(f.sends.findLast((send) => send.txn === f.sends[0]?.txn)?.content).toEqual(
		f.sends[0]?.content,
	);
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
	const originals = f.sends.length;
	expect(originals).toBe(10);
	await p.stream("s", "1730000000000", f.message("y".repeat(24000)), true);
	for (const send of f.sends)
		expect(Buffer.byteLength(JSON.stringify(send.content))).toBeLessThanOrEqual(60_000);
	expect(f.sends.slice(originals).map((s) => s.content["m.relates_to"]?.event_id)).toEqual(
		f.sends.slice(0, originals).map((s) => `$${s.txn}`),
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

test("legacy short receipts retain the original stride", async () => {
	const f = fixture();
	const seeded = emptyProjection();
	seeded.sessions.s = {
		projectId: "p",
		workspaceId: "w",
		sessionId: "s",
		roomId: "!old",
		sent: [],
		streams: {
			[projectionTransactionId("s:1730000000000")]: {
				text: "Assistant: short",
				chunks: [{ eventId: "$old", text: "Assistant: short", revision: 1 }],
			},
		},
	};
	f.seed(seeded);
	const text = "0123456789".repeat(2500);
	await f.make().stream("s", "1730000000000", f.message(text), true);
	expect(f.sends.map((s) => s.content.body).join("")).toBe(`Assistant: ${text}`);
	expect(f.sends[0]?.content.body.length).toBe(12000);
});

test("partial fence markers retain context and invalid info does not open a fence", () => {
	expect(isMarkdownContinuation("User: ```ts\ncode", 7)).toBe(true);
	expect(isMarkdownContinuation("Assistant: ```bad`info\ntext", 30)).toBe(false);
});

test("restart after persisting exact modern pending content preserves every projected source offset", async () => {
	let crash = true;
	const key = projectionTransactionId("s:1730000000000");
	const f = fixture({
		save: (state) => {
			if (crash && state.sessions.s?.streams?.[key]?.chunks[0]?.pendingContent) {
				crash = false;
				throw new Error("crash after pending content save");
			}
		},
	});
	const text = "0123456789abcdef".repeat(1_700);
	const body = `Assistant: ${text}`;
	const p = f.make();
	await p.reconcile();
	await expect(p.stream("s", "1730000000000", f.message(text), true)).rejects.toThrow(
		"crash after pending content save",
	);
	expect(f.sends).toHaveLength(0);
	const receipt = f.state().sessions.s?.streams?.[key];
	expect(receipt?.chunkSize).toBe(2_500);
	expect(receipt?.chunks[0]?.pending).toBe(body.slice(0, 2_500));
	const pendingContent = structuredClone(receipt?.chunks[0]?.pendingContent);
	expect(pendingContent).toMatchObject({
		msgtype: "m.notice",
		body: body.slice(0, 2_500),
		format: "org.matrix.custom.html",
	});
	await f.make().stream("s", "1730000000000", f.message(text), true);
	expect(pendingContent).toEqual(f.sends[0]?.content);
	expect(f.sends).toHaveLength(Math.ceil(body.length / 2_500));
	expect(f.sends.every(({ content }) => content["m.relates_to"] === undefined)).toBe(true);
	expect(f.sends.map(({ content }) => content.body).join("")).toBe(body);
	for (const [i, send] of f.sends.entries()) {
		expect(send.content.body).toBe(body.slice(i * 2_500, (i + 1) * 2_500));
		expect(send.txn).toBe(projectionTransactionId(`stream:s:1730000000000:${i}:0`));
	}
});

test("expansion-heavy Markdown replacement measures the complete JSON envelope and falls back to plain", async () => {
	const f = fixture();
	const p = f.make();
	await p.reconcile();
	await p.stream("s", "1730000000000", f.message("partial"), false);
	const text = `${"[^a]".repeat(600)}\n\n[^a]: note`;
	await p.stream("s", "1730000000000", f.message(text), true);
	expect(f.sends).toHaveLength(2);
	const original = f.sends[0];
	const replacement = f.sends[1]?.content;
	expect(replacement).toEqual({
		msgtype: "m.notice",
		body: `Assistant: ${text}`,
		"m.new_content": { msgtype: "m.notice", body: `Assistant: ${text}` },
		"m.relates_to": { rel_type: "m.replace", event_id: `$${original?.txn}` },
	});
	for (const send of f.sends) {
		expect(Buffer.byteLength(JSON.stringify(send.content))).toBeLessThanOrEqual(60_000);
	}
});

for (const eventId of [undefined, "$legacy-original"]) {
	test(`legacy short pending ${eventId ? "edit" : "original"} without chunkSize replays exact plain content before 12000-stride updates`, async () => {
		const f = fixture();
		const seeded = emptyProjection();
		const pending = "Assistant: **short pending**";
		seeded.sessions.s = {
			projectId: "p",
			workspaceId: "w",
			sessionId: "s",
			roomId: "!legacy",
			sent: [],
			streams: {
				[projectionTransactionId("s:1730000000000")]: {
					chunks: [
						{
							...(eventId ? { eventId, text: "Assistant: old" } : {}),
							pending,
							revision: eventId ? 1 : 0,
						},
					],
					pending: { text: pending, final: false },
				},
			},
		};
		f.seed(seeded);
		const text = "0123456789abcdef".repeat(1_700);
		const body = `Assistant: ${text}`;
		await f.make().stream("s", "1730000000000", f.message(text), true);
		const notice = { msgtype: "m.notice", body: pending };
		expect(f.sends[0]?.content).toEqual(
			eventId
				? {
						...notice,
						"m.new_content": notice,
						"m.relates_to": { rel_type: "m.replace", event_id: eventId },
					}
				: notice,
		);
		expect(f.sends[0]?.txn).toBe(
			projectionTransactionId(`stream:s:1730000000000:0:${eventId ? 1 : 0}`),
		);
		const updates = f.sends.slice(1);
		expect(updates).toHaveLength(Math.ceil(body.length / 12_000));
		expect(updates.map(({ content }) => content.body).join("")).toBe(body);
		for (const [i, send] of updates.entries()) {
			expect(send.content.body).toBe(body.slice(i * 12_000, (i + 1) * 12_000));
			expect(send.content["m.relates_to"]).toEqual(
				i === 0
					? {
							rel_type: "m.replace",
							event_id: eventId ?? `$${f.sends[0]?.txn}`,
						}
					: undefined,
			);
		}
		expect(
			f.state().sessions.s?.streams?.[projectionTransactionId("s:1730000000000")]?.chunkSize,
		).toBe(12_000);
	});
}

test("legacy unversioned mapping keeps plain 12000 chunks and stable historical transactions", async () => {
	const f = fixture();
	const seeded = emptyProjection();
	seeded.explicitSessionIds = ["s"];
	seeded.sessions.s = {
		projectId: "p",
		workspaceId: "w",
		sessionId: "s",
		roomId: "!legacy",
		sent: [],
	};
	f.seed(seeded);
	const text = "0123456789abcdef".repeat(1_600);
	f.history([{ role: "user", timestamp: 1730000000000, content: [{ type: "text", text }] }]);
	f.target.state.execution = "idle";
	f.target.state.backgroundWork = true;
	const body = `User: ${text}`;
	const hash = createHash("sha256").update(body).digest("hex");
	// The old server accepted offset zero, but its response was lost before
	// the bridge could persist the message hash. Model Matrix txn dedup below.
	const accepted = {
		content: { msgtype: "m.notice", body: body.slice(0, 12_000) },
		txn: projectionTransactionId(`s:${hash}:0`),
	};
	const p = f.make();
	await p.reconcile();
	const firstPass = f.sends.slice();
	expect(firstPass[0]).toEqual(accepted);
	const delivered = new Map([accepted, ...firstPass].map((send) => [send.txn, send.content]));
	expect([...delivered.values()].map((content) => content.body).join("")).toBe(body);
	expect(delivered.size).toBe(Math.ceil(body.length / 12_000));
	expect(firstPass.map(({ content }) => content.body)).toEqual(
		Array.from({ length: Math.ceil(`User: ${text}`.length / 12_000) }, (_, i) =>
			`User: ${text}`.slice(i * 12_000, (i + 1) * 12_000),
		),
	);
	expect(firstPass.every(({ content }) => content.formatted_body === undefined)).toBe(true);
	await p.reconcile();
	expect(f.sends).toEqual(firstPass);
	expect(f.state().sessions.s?.historyFormat).toBeUndefined();
});

test("user history leading fenced code renders pre/code only before the plain continuation", async () => {
	const f = fixture();
	const text = `\`\`\`ts\n${"const value = 1;\n".repeat(400)}\`\`\``;
	f.history([{ role: "user", timestamp: 1730000000000, content: [{ type: "text", text }] }]);
	f.target.state.execution = "idle";
	f.target.state.backgroundWork = true;
	await f.make().reconcile();
	expect(f.state().sessions.s?.historyFormat).toBe("markdown-v1");
	expect(f.sends.length).toBeGreaterThan(1);
	expect(f.sends[0]?.content.format).toBe("org.matrix.custom.html");
	expect(f.sends[0]?.content.formatted_body).toContain('<pre><code class="language-ts">');
	expect(f.sends[0]?.content.formatted_body).toContain("const value = 1;");
	for (const send of f.sends.slice(1)) {
		expect(send.content.format).toBeUndefined();
		expect(send.content.formatted_body).toBeUndefined();
	}
	expect(f.sends.map(({ content }) => content.body).join("")).toBe(`User: ${text}`);
});
