import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodedError } from "@thinkrail/shared/codedError";
import { createIssueConfirmationStore } from "./issueConfirmations";

const roots: string[] = [];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "issue-confirmations-"));
	roots.push(root);
	return { root, store: createIssueConfirmationStore(root) };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const unavailable = {
	code: "ISSUE_CONFIRMATION_BLOCKED",
};

test("immutable preparation, durable completion and replay survive restart", async () => {
	const { root, store } = setup();
	const payload = { issue: 42, design: "confirmed" };
	const prepared = await store.prepare("session", "op:1", payload);
	expect(prepared.digest).toBe(hash(JSON.stringify(payload)));
	payload.design = "changed";
	expect(await store.get("session", "op:1")).toEqual(prepared);
	expect(await store.get("session", "absent")).toBeNull();
	let calls = 0;
	const run = async () => {
		calls++;
		return { noteId: 7 };
	};
	expect(await store.execute("session", "op:1", prepared.digest, "call:1", run)).toEqual({
		noteId: 7,
	});
	const restarted = createIssueConfirmationStore(root);
	expect(await restarted.execute("session", "op:1", prepared.digest, "call:1", run)).toEqual({
		noteId: 7,
	});
	expect(calls).toBe(1);
	expect(await restarted.listCompleted()).toEqual([
		{ sessionId: "session", operationId: "op:1", payload: prepared.payload, result: { noteId: 7 } },
	]);
	await expect(store.prepare("session", "op:1", payload)).rejects.toMatchObject(unavailable);
	await expect(
		store.execute("session", "op:1", prepared.digest, "other", run),
	).rejects.toMatchObject(unavailable);
	await expect(
		store.execute("session", "op:1", "0".repeat(64), "call:1", run),
	).rejects.toMatchObject(unavailable);
});

test("pending intent blocks replay, other operations and concurrent stores before callback settles", async () => {
	const { root, store } = setup();
	const a = await store.prepare("session", "a", null);
	const b = await store.prepare("session", "b", null);
	let finish!: (value: unknown) => void;
	let calls = 0;
	const first = store.execute("session", "a", a.digest, "call", () => {
		calls++;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const other = createIssueConfirmationStore(root);
	await expect(
		other.execute("session", "a", a.digest, "call", async () => {
			calls++;
		}),
	).rejects.toMatchObject(unavailable);
	await expect(
		other.execute("session", "b", b.digest, "call2", async () => {
			calls++;
		}),
	).rejects.toMatchObject(unavailable);
	await expect(other.prepare("session", "c", {})).rejects.toMatchObject(unavailable);
	expect(calls).toBe(1);
	finish({ noteId: 9 });
	await first;
	await other.prepare("session", "c", {});
});

test("callback failure leaves durable intent and sanitizes arbitrary errors", async () => {
	const { root, store } = setup();
	const { digest } = await store.prepare("session", "op", {});
	await expect(
		store.execute("session", "op", digest, "call", async () => {
			throw new Error("secret credential");
		}),
	).rejects.toMatchObject(unavailable);
	const restarted = createIssueConfirmationStore(root);
	await expect(
		restarted.execute("session", "op", digest, "call", async () => 3),
	).rejects.toMatchObject(unavailable);
	await expect(restarted.prepare("session", "next", {})).rejects.toMatchObject(unavailable);
	expect(await restarted.listCompleted()).toEqual([]);
});

test("torn journal, mismatched identities and symlink files fail closed", async () => {
	for (const corruption of ["", "{}", "null", "{", JSON.stringify({ sessionId: "wrong" })]) {
		const { root, store } = setup();
		await store.prepare("session", "op", {});
		const path = join(root, hash("session"));
		const file = readdirSync(path)[0];
		expect(file).toBeDefined();
		if (!file) throw new Error("Missing prepared record");
		writeFileSync(join(path, file), corruption);
		await expect(store.get("session", "op")).rejects.toMatchObject(unavailable);
		await expect(store.inspect("session", "op")).rejects.toMatchObject(unavailable);
		await expect(store.listCompleted()).rejects.toMatchObject(unavailable);
	}
	const { root, store } = setup();
	await store.prepare("session", "op", {});
	const path = join(root, hash("session"));
	const file = readdirSync(path)[0];
	if (!file) throw new Error("Missing prepared record");
	const target = join(path, file);
	const copy = join(root, "copy");
	writeFileSync(copy, readFileSync(target));
	rmSync(target);
	symlinkSync(copy, target);
	await expect(store.get("session", "op")).rejects.toMatchObject(unavailable);
});

test("validates IDs, JSON values, byte bounds and trusted directories", async () => {
	const { root, store } = setup();
	for (const bad of ["../bad", "", "a/b", "a.b", "a:b", "a".repeat(129)]) {
		await expect(store.prepare(bad, "op", {})).rejects.toMatchObject(unavailable);
	}
	for (const bad of ["../bad", "", "a/b", "a".repeat(129)]) {
		await expect(store.prepare("session", bad, {})).rejects.toMatchObject(unavailable);
	}
	const cycle: unknown[] = [];
	cycle.push(cycle);
	for (const bad of [
		undefined,
		NaN,
		Infinity,
		1n,
		{ hidden: undefined },
		cycle,
		new Date(),
		"é".repeat(65536),
	]) {
		await expect(store.prepare("session", "op", bad)).rejects.toMatchObject(unavailable);
	}
	await store.prepare("session", "limit", "a".repeat(131070));
	await expect(
		createIssueConfirmationStore(join(root, "missing")).get("s", "op"),
	).rejects.toMatchObject(unavailable);
	const elsewhere = mkdtempSync(join(tmpdir(), "issue-confirmations-target-"));
	roots.push(elsewhere);
	const link = join(root, "linked");
	symlinkSync(elsewhere, link, "junction");
	await expect(createIssueConfirmationStore(link).get("s", "op")).rejects.toMatchObject(
		unavailable,
	);
	const childRoot = setup();
	symlinkSync(elsewhere, join(childRoot.root, hash("session")), "junction");
	await expect(childRoot.store.prepare("session", "op", {})).rejects.toMatchObject(unavailable);
	mkdirSync(join(root, "unexpected"));
	await expect(store.listCompleted()).rejects.toMatchObject(unavailable);
});

test("opaque Responses tool-call IDs execute once and replay after restart", async () => {
	for (const toolCallId of [
		"call_abc123|fc_0123456789abcdef",
		"\u5de5\u5177|\u8c03\u7528",
		"x".repeat(512),
	]) {
		const { root, store } = setup();
		const { digest } = await store.prepare("session", "op", {});
		let calls = 0;
		const run = async () => ({ noteId: ++calls });
		expect(await store.execute("session", "op", digest, toolCallId, run)).toEqual({ noteId: 1 });
		const restarted = createIssueConfirmationStore(root);
		expect(await restarted.execute("session", "op", digest, toolCallId, run)).toEqual({
			noteId: 1,
		});
		expect(await restarted.listCompleted()).toHaveLength(1);
		expect(calls).toBe(1);
	}
});

test("invalid opaque tool-call IDs are rejected on execution and journal read", async () => {
	for (const toolCallId of [
		"",
		"x".repeat(513),
		"call id",
		"call\tid",
		"call\nid",
		"call\u0000id",
		"call\u007fid",
		"call\u0085id",
	]) {
		const { root, store } = setup();
		const { digest } = await store.prepare("session", "op", {});
		let calls = 0;
		const run = async () => ++calls;
		await expect(store.execute("session", "op", digest, toolCallId, run)).rejects.toMatchObject(
			unavailable,
		);
		expect(calls).toBe(0);
		await store.execute("session", "op", digest, "call_valid|fc_valid", run);
		const path = join(root, hash("session"), "1.intent");
		const intent = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...intent, toolCallId }));
		await expect(createIssueConfirmationStore(root).get("session", "op")).rejects.toMatchObject(
			unavailable,
		);
	}
});

test("inspection survives restart without changing records and exposes frozen recovery states", async () => {
	const { root, store } = setup();
	expect(await store.inspect("session", "missing")).toEqual({ status: "missing" });
	expect(readdirSync(root)).toEqual([]);
	const prepared = await store.prepare("session", "op", { questions: ["Looks right"] });
	const path = join(root, hash("session"));
	const snapshot = () =>
		readdirSync(path)
			.sort()
			.map((name) => [name, readFileSync(join(path, name), "utf8")]);
	const before = snapshot();
	const restarted = createIssueConfirmationStore(root);
	expect(await restarted.inspect("session", "op")).toEqual({ status: "prepared", ...prepared });
	expect(snapshot()).toEqual(before);
	// A prepared-only operation can be confirmed with a new receipt; no payload replacement occurs.
	expect(await restarted.prepare("session", "op", prepared.payload)).toEqual(prepared);
	await expect(restarted.prepare("session", "op", { changed: true })).rejects.toMatchObject({
		code: unavailable.code,
		message: expect.stringContaining("(payload_changed)"),
	});
	await restarted.execute("session", "op", prepared.digest, "new-confirmation", async () => ({
		id: 1,
	}));
	const completed = snapshot();
	expect(await store.inspect("session", "op")).toEqual({
		status: "completed",
		...prepared,
		result: { id: 1 },
	});
	expect(snapshot()).toEqual(completed);
});

test("uncertain inspection retains frozen questions and cannot be bypassed with a new ID", async () => {
	const { root, store } = setup();
	const prepared = await store.prepare("session", "op", { questions: ["Looks right"] });
	await expect(
		store.execute("session", "op", prepared.digest, "call", async () => {
			throw new Error("secret remote failure");
		}),
	).rejects.toMatchObject({
		code: unavailable.code,
		message: expect.stringContaining("(uncertain_intent)"),
	});
	const restarted = createIssueConfirmationStore(root);
	expect(await restarted.inspect("session", "op")).toEqual({ status: "uncertain", ...prepared });
	await expect(restarted.prepare("session", "replacement", {})).rejects.toMatchObject({
		code: unavailable.code,
		message: expect.stringContaining("(uncertain_intent)"),
	});
	let calls = 0;
	await expect(
		restarted.execute("session", "op", prepared.digest, "new-call", async () => ++calls),
	).rejects.toMatchObject({
		code: unavailable.code,
		message: expect.stringContaining("(uncertain_intent)"),
	});
	expect(calls).toBe(0);
});

test("read-only preflight refusal leaves no intent and preserves its coded reason", async () => {
	const { store } = setup();
	const prepared = await store.prepare("session", "op", {});
	let calls = 0;
	await expect(
		store.execute(
			"session",
			"op",
			prepared.digest,
			"call",
			async () => ++calls,
			async () => {
				throw new CodedError("ISSUE_DELIVERY_REFUSED", "checkout-commit-changed");
			},
		),
	).rejects.toMatchObject({ code: "ISSUE_DELIVERY_REFUSED", message: "checkout-commit-changed" });
	expect(calls).toBe(0);
	expect((await store.inspect("session", "op")).status).toBe("prepared");
	await store.prepare("session", "review-current-head", { current: true });
});

test("a concurrent intent admitted during preflight prevents a second dispatch", async () => {
	const { store } = setup();
	const prepared = await store.prepare("session", "op", {});
	let calls = 0;
	await expect(
		store.execute(
			"session",
			"op",
			prepared.digest,
			"call",
			async () => ++calls,
			async () => {
				await store.execute("session", "op", prepared.digest, "other", async () => ++calls);
			},
		),
	).rejects.toMatchObject({ code: "ISSUE_CONFIRMATION_BLOCKED" });
	expect(calls).toBe(1);
});

test("deterministic pre-dispatch failures preserve their reason and leave preparation safe", async () => {
	const { store } = setup();
	const prepared = await store.prepare("session", "op", {});
	let calls = 0;
	for (const [operation, digest, call, reason] of [
		["missing", prepared.digest, "call", "operation_missing"],
		["op", "0".repeat(64), "call", "digest_mismatch"],
		["op", prepared.digest, "bad call", "invalid_input"],
	] as const) {
		await expect(
			store.execute("session", operation, digest, call, async () => ++calls),
		).rejects.toMatchObject({
			code: unavailable.code,
			message: expect.stringContaining(`(${reason})`),
		});
	}
	expect(calls).toBe(0);
	expect(await store.inspect("session", "op")).toEqual({ status: "prepared", ...prepared });
	await store.prepare("session", "fresh", {});
});
