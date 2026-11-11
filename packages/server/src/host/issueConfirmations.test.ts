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
	code: "RESOURCE_UNAVAILABLE",
	message: "Issue confirmation requires reconciliation.",
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
