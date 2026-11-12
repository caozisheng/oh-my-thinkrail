import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CodedError } from "@thinkrail/shared/codedError";

const maxPayloadBytes = 131072;
const maxRecordBytes = maxPayloadBytes + 4096;
const maxOperations = 1000;
interface Prepared {
	sessionId: string;
	operationId: string;
	digest: string;
	payload: unknown;
}
interface Intent {
	sessionId: string;
	operationId: string;
	digest: string;
	toolCallId: string;
}
interface Operation {
	prepared: Prepared;
	intent?: Intent;
	completed?: { result: unknown };
}
const blockedMessages = {
	invalid_input: "Use valid session, operation, digest and tool-call identifiers.",
	invalid_payload: "Provide bounded plain JSON for the confirmation payload.",
	unsafe_directory: "Restore the trusted journal directory before continuing.",
	journal_invalid:
		"The journal is invalid. Reconcile its records before continuing; do not retry mutation.",
	journal_unavailable:
		"The journal could not be read or persisted. Restore access and inspect its state before continuing.",
	payload_changed:
		"This operation has a frozen payload. Inspect it; prepare a new operation and confirmation for changed content only when no intent is uncertain.",
	operation_missing: "Prepare this operation and obtain its confirmation before execution.",
	digest_mismatch: "Inspect the frozen payload and use its digest with the matching confirmation.",
	confirmation_mismatch:
		"This operation already has an intent for another confirmation. Inspect its status and reconcile before continuing.",
	uncertain_intent:
		"A mutation may have been dispatched. Inspect and reconcile the existing intent before preparing or executing another operation; changing the operation ID cannot bypass it.",
	capacity_reached:
		"The journal limit has been reached. Reconcile and retain its records before continuing.",
	intent_conflict:
		"Another execution reserved this journal revision. Inspect its status before continuing.",
	preflight_failed:
		"Read-only validation failed before any intent was reserved. Inspect current facts and obtain a refreshed confirmation.",
} as const;
type BlockedReason = keyof typeof blockedMessages;
function stop(reason: BlockedReason = "journal_invalid"): never {
	throw new CodedError(
		"ISSUE_CONFIRMATION_BLOCKED",
		`Issue confirmation blocked (${reason}). ${blockedMessages[reason]}`,
	);
}

export type IssueConfirmationInspection =
	| { status: "missing" }
	| { status: "prepared" | "uncertain"; digest: string; payload: unknown }
	| { status: "completed"; digest: string; payload: unknown; result: unknown };
function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function validId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
function validOperation(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
// Provider tool-call IDs are opaque (Responses IDs can contain a pipe).
function validToolCallId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 512 &&
		!/[\p{Cc}\s]/u.test(value)
	);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
function absent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function directory(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) stop("unsafe_directory");
}
function flushDirectory(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch (error) {
		if (
			process.platform !== "win32" ||
			!["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function json(value: unknown, reason: BlockedReason = "invalid_payload"): string {
	const ancestors = new Set<object>();
	function validate(input: unknown): void {
		if (input === null || typeof input === "string" || typeof input === "boolean") return;
		if (typeof input === "number" && Number.isFinite(input)) return;
		if (typeof input !== "object" || ancestors.has(input)) stop(reason);
		ancestors.add(input);
		if (Array.isArray(input)) {
			if (Reflect.ownKeys(input).length !== input.length + 1) stop(reason);
			for (let n = 0; n < input.length; n++) {
				const descriptor = Object.getOwnPropertyDescriptor(input, String(n));
				if (!descriptor || !("value" in descriptor)) stop(reason);
				validate(descriptor.value);
			}
		} else {
			if (
				Object.getPrototypeOf(input) !== Object.prototype &&
				Object.getPrototypeOf(input) !== null
			)
				stop(reason);
			for (const key of Reflect.ownKeys(input)) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key);
				if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
					stop(reason);
				validate(descriptor.value);
			}
		}
		ancestors.delete(input);
	}
	validate(value);
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > maxPayloadBytes) stop(reason);
	return text;
}

/** Existing private trusted root; no automatic replay or remote verification. */
export function createIssueConfirmationStore(root: string) {
	const base = resolve(root);
	function sessionPath(sessionId: string): string {
		if (!validId(sessionId)) stop("invalid_input");
		directory(base);
		return join(base, hash(sessionId));
	}
	function read(path: string, durable = true): unknown | null {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > maxRecordBytes)
				stop();
			const fd = openSync(path, durable ? "r+" : "r");
			try {
				const current = fstatSync(fd);
				if (!current.isFile() || current.size !== stat.size || current.size > maxRecordBytes)
					stop();
				const bytes = Buffer.alloc(maxRecordBytes + 1);
				let length = 0;
				while (length < bytes.length) {
					const count = readSync(fd, bytes, length, bytes.length - length, null);
					if (!count) break;
					length += count;
				}
				if (length !== current.size) stop();
				const value: unknown = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
				);
				if (value === null) stop();
				if (durable) fsyncSync(fd);
				return value;
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if (absent(error)) return null;
			if (error instanceof CodedError) throw error;
			return stop("journal_unavailable");
		}
	}
	function write(path: string, value: unknown, parent: string): void {
		const text = JSON.stringify(value);
		if (Buffer.byteLength(text) > maxRecordBytes) stop();
		// Never remove an exclusive claim, even after a failed write or flush.
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		flushDirectory(parent);
		flushDirectory(base);
	}
	function parsePrepared(value: unknown): Prepared {
		if (
			!exact(value, ["sessionId", "operationId", "digest", "payload"]) ||
			!validId(value.sessionId) ||
			!validOperation(value.operationId) ||
			typeof value.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.digest) ||
			hash(json(value.payload, "journal_invalid")) !== value.digest
		)
			stop();
		return {
			sessionId: value.sessionId,
			operationId: value.operationId,
			digest: value.digest,
			payload: value.payload,
		};
	}
	function scan(sessionId: string, durable = true) {
		const path = sessionPath(sessionId);
		try {
			directory(path);
		} catch (error) {
			if (absent(error))
				return { path, ops: new Map<string, Operation>(), revisions: 0, pending: false };
			throw error;
		}
		const names = readdirSync(path);
		if (names.length > maxOperations * 3) stop();
		const ops = new Map<string, Operation>();
		for (const name of names) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) {
				if (!/^[1-9][0-9]{0,3}\.(intent|completed)$/.test(name)) stop();
				continue;
			}
			const prepared = parsePrepared(read(join(path, name), durable));
			if (
				prepared.sessionId !== sessionId ||
				`${hash(prepared.operationId)}.json` !== name ||
				ops.has(prepared.operationId)
			)
				stop();
			ops.set(prepared.operationId, { prepared });
		}
		const revisions = names.filter((name) => name.endsWith(".intent")).length;
		if (
			revisions > maxOperations ||
			names.filter((name) => name.endsWith(".completed")).length > revisions
		)
			stop();
		let pending = false;
		let completions = 0;
		for (let n = 1; n <= revisions; n++) {
			const raw = read(join(path, `${n}.intent`), durable);
			if (
				!exact(raw, ["sessionId", "operationId", "digest", "toolCallId"]) ||
				raw.sessionId !== sessionId ||
				!validOperation(raw.operationId) ||
				!validToolCallId(raw.toolCallId) ||
				typeof raw.digest !== "string"
			)
				stop();
			const op = ops.get(raw.operationId);
			if (!op || op.intent || op.prepared.digest !== raw.digest) stop();
			op.intent = {
				sessionId,
				operationId: raw.operationId,
				digest: raw.digest,
				toolCallId: raw.toolCallId,
			};
			const completed = read(join(path, `${n}.completed`), durable);
			if (completed === null) {
				if (n !== revisions) stop();
				pending = true;
			} else {
				if (
					!exact(completed, ["sessionId", "operationId", "digest", "toolCallId", "result"]) ||
					completed.sessionId !== sessionId ||
					completed.operationId !== raw.operationId ||
					completed.digest !== raw.digest ||
					completed.toolCallId !== raw.toolCallId
				)
					stop();
				json(completed.result, "journal_invalid");
				op.completed = { result: completed.result };
				completions++;
			}
		}
		if (names.filter((name) => name.endsWith(".completed")).length !== completions) stop();
		if (durable) {
			flushDirectory(path);
			flushDirectory(base);
		}
		return { path, ops, revisions, pending };
	}
	async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof CodedError) throw error;
			return stop("journal_unavailable");
		}
	}
	return {
		prepare(
			sessionId: string,
			operationId: string,
			payload: unknown,
		): Promise<{ digest: string; payload: unknown }> {
			return guarded(() => {
				if (!validOperation(operationId)) stop("invalid_input");
				const encoded = json(payload);
				const digest = hash(encoded);
				const snapshot: unknown = JSON.parse(encoded);
				const state = scan(sessionId);
				const existing = state.ops.get(operationId);
				if (existing) {
					if (existing.prepared.digest !== digest) stop("payload_changed");
					return { digest, payload: existing.prepared.payload };
				}
				if (state.pending) stop("uncertain_intent");
				if (state.ops.size >= maxOperations) stop("capacity_reached");
				try {
					mkdirSync(state.path, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				directory(state.path);
				const prepared = { sessionId, operationId, digest, payload: snapshot };
				try {
					write(join(state.path, `${hash(operationId)}.json`), prepared, state.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const winner = scan(sessionId).ops.get(operationId);
					if (!winner || winner.prepared.digest !== digest) stop("payload_changed");
				}
				return { digest, payload: snapshot };
			});
		},
		/** Read-only diagnostics; prepared payloads remain immutable and uncertain intents stay fenced. */
		inspect(sessionId: string, operationId: string): Promise<IssueConfirmationInspection> {
			return guarded(() => {
				if (!validOperation(operationId)) stop("invalid_input");
				const op = scan(sessionId, false).ops.get(operationId);
				if (!op) return { status: "missing" };
				const frozen = { digest: op.prepared.digest, payload: op.prepared.payload };
				if (op.completed) return { status: "completed", ...frozen, result: op.completed.result };
				return { status: op.intent ? "uncertain" : "prepared", ...frozen };
			});
		},
		get(
			sessionId: string,
			operationId: string,
		): Promise<{ digest: string; payload: unknown } | null> {
			return guarded(() => {
				if (!validOperation(operationId)) stop("invalid_input");
				const op = scan(sessionId).ops.get(operationId);
				return op ? { digest: op.prepared.digest, payload: op.prepared.payload } : null;
			});
		},
		execute(
			sessionId: string,
			operationId: string,
			digest: string,
			toolCallId: string,
			run: () => Promise<unknown>,
			preflight?: () => Promise<void>,
		): Promise<unknown> {
			return guarded(async () => {
				if (
					!validOperation(operationId) ||
					!validToolCallId(toolCallId) ||
					typeof digest !== "string" ||
					!/^[a-f0-9]{64}$/.test(digest) ||
					typeof run !== "function"
				)
					stop("invalid_input");
				let state = scan(sessionId);
				let op = state.ops.get(operationId);
				if (!op) stop("operation_missing");
				if (op.prepared.digest !== digest) stop("digest_mismatch");
				if (op.intent) {
					if (!op.completed) stop("uncertain_intent");
					if (op.intent.toolCallId !== toolCallId) stop("confirmation_mismatch");
					return op.completed.result;
				}
				if (state.pending) stop("uncertain_intent");
				try {
					await preflight?.();
				} catch (error) {
					if (error instanceof CodedError) throw error;
					stop("preflight_failed");
				}
				state = scan(sessionId);
				op = state.ops.get(operationId);
				if (!op || op.prepared.digest !== digest) stop("digest_mismatch");
				if (op.intent || state.pending) stop("uncertain_intent");
				if (state.revisions >= maxOperations) stop("capacity_reached");
				const intent = { sessionId, operationId, digest, toolCallId };
				const revision = state.revisions + 1;
				try {
					write(join(state.path, `${revision}.intent`), intent, state.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") stop("intent_conflict");
					throw error;
				}
				let encodedResult: string;
				try {
					encodedResult = json(await run());
				} catch {
					return stop("uncertain_intent");
				}
				const result: unknown = JSON.parse(encodedResult);
				directory(base);
				directory(state.path);
				write(join(state.path, `${revision}.completed`), { ...intent, result }, state.path);
				return result;
			});
		},
		listCompleted(): Promise<
			{ sessionId: string; operationId: string; payload: unknown; result: unknown }[]
		> {
			return guarded(() => {
				directory(base);
				const output: {
					sessionId: string;
					operationId: string;
					payload: unknown;
					result: unknown;
				}[] = [];
				for (const name of readdirSync(base).sort()) {
					if (!/^[a-f0-9]{64}$/.test(name)) stop();
					const path = join(base, name);
					directory(path);
					const files = readdirSync(path).sort();
					if (files.length === 0) continue;
					const preparedFile = files.find((file) => /^[a-f0-9]{64}\.json$/.test(file));
					if (!preparedFile) stop();
					const identity = parsePrepared(read(join(path, preparedFile)));
					if (hash(identity.sessionId) !== name) stop();
					const state = scan(identity.sessionId);
					for (const op of state.ops.values()) {
						if (op.completed)
							output.push({
								sessionId: identity.sessionId,
								operationId: op.prepared.operationId,
								payload: op.prepared.payload,
								result: op.completed.result,
							});
					}
				}
				return output.sort((a, b) => {
					const left = `${a.sessionId}/${a.operationId}`;
					const right = `${b.sessionId}/${b.operationId}`;
					return left < right ? -1 : left > right ? 1 : 0;
				});
			});
		},
	};
}

// Optional on the port so existing structural adapters remain compatible.
export type IssueConfirmationStore = Omit<
	ReturnType<typeof createIssueConfirmationStore>,
	"inspect"
> &
	Partial<Pick<ReturnType<typeof createIssueConfirmationStore>, "inspect">>;
