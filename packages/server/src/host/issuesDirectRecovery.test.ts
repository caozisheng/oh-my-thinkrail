import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssueConfirmationStore, type IssueConfirmationStore } from "./issueConfirmations";
import { reconcileDirectOperation } from "./issuesDirectRecovery";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "issues-direct-recovery-"));
	roots.push(root);
	const store = createIssueConfirmationStore(root);
	return { root, store };
}
const payload = { stage: "design", directRequest: { operationId: "op" } };
const blocked = { code: "ISSUE_CONFIRMATION_BLOCKED" };
async function uncertain(store: IssueConfirmationStore) {
	const prepared = await store.prepare("session", "op", payload);
	await expect(
		store.execute("session", "op", prepared.digest, "original", async () => {
			throw new Error("lost response");
		}),
	).rejects.toMatchObject(blocked);
}
function reconcile(store: IssueConfirmationStore, observe: (payload: unknown) => Promise<unknown>) {
	return reconcileDirectOperation({ sessionId: "session", operationId: "op", store, observe });
}

test("adopts only the twice-observed original result and persists across restart", async () => {
	const { root, store } = setup();
	await uncertain(store);
	let reads = 0;
	const result = { noteId: 42 };
	expect(
		await reconcile(store, async (frozen) => {
			expect(frozen).toEqual(payload);
			reads++;
			return { result, evidence: { noteId: 42, labels: ["design"] } };
		}),
	).toEqual(result);
	expect(reads).toBe(2);
	const restarted = createIssueConfirmationStore(root);
	expect(await restarted.inspect("session", "op")).toMatchObject({ status: "completed", result });
	const recovery = await restarted.getRecovery("session", "op");
	expect(recovery?.candidate).toMatchObject({ result });
	// The deterministic token permits identical journal-level recovery replay.
	let token = "";
	const { store: second } = setup();
	await uncertain(second);
	const complete = second.completeRecovery.bind(second);
	second.completeRecovery = async (...args) => {
		token = args[3];
		return complete(...args);
	};
	await reconcile(second, async () => recovery?.candidate);
	expect(token).toMatch(/^host-reconcile:[a-f0-9]{64}$/);
	if (!recovery) throw new Error("Expected persisted recovery candidate");
	expect(
		await restarted.completeRecovery("session", "op", recovery.candidateDigest, token, async () => {
			throw new Error("completed replay must not observe");
		}),
	).toEqual(result);
});

test("missing, prepared and completed return status only without observation", async () => {
	const { store } = setup();
	const observe = async () => {
		throw new Error("must not observe");
	};
	expect(await reconcile(store, observe)).toEqual({ status: "missing" });
	const prepared = await store.prepare("session", "op", payload);
	expect(await reconcile(store, observe)).toEqual({ status: "prepared" });
	await store.execute("session", "op", prepared.digest, "original", async () => ({
		secret: "receipt",
	}));
	expect(await reconcile(store, observe)).toEqual({ status: "completed" });
});

test("active execution cannot be adopted even when remote observation looks successful", async () => {
	const { store } = setup();
	const prepared = await store.prepare("session", "op", payload);
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const execution = store.execute("session", "op", prepared.digest, "original", async () => {
		started();
		await waiting;
		return { noteId: 42 };
	});
	await running;
	try {
		await expect(reconcile(store, async () => ({ result: { noteId: 42 } }))).rejects.toMatchObject(
			blocked,
		);
		expect(await store.inspect("session", "op")).toMatchObject({ status: "uncertain" });
	} finally {
		release();
		await execution;
	}
});

test.each(["missing", "changed", "invalid"])(
	"%s observation leaves uncertainty fenced",
	async (mode) => {
		const { store } = setup();
		await uncertain(store);
		let reads = 0;
		await expect(
			reconcile(store, async () => {
				reads++;
				if (mode === "missing") throw new Error("private remote failure");
				if (mode === "invalid") return { absent: true };
				return { result: { noteId: reads } };
			}),
		).rejects.toMatchObject({
			...blocked,
			message: expect.stringContaining("No safe observed-result recovery"),
		});
		expect(await store.inspect("session", "op")).toMatchObject({ status: "uncertain" });
		await expect(store.prepare("session", "replacement", payload)).rejects.toMatchObject(blocked);
	},
);

test.each(["inspect", "prepareRecovery", "completeRecovery"] as const)(
	"requires optional store method %s",
	async (method) => {
		const { store } = setup();
		const partial: IssueConfirmationStore = { ...store, [method]: undefined };
		await expect(reconcile(partial, async () => ({ result: true }))).rejects.toMatchObject(blocked);
	},
);
