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
function stop(): never {
	throw new CodedError("RESOURCE_UNAVAILABLE", "Issue confirmation requires reconciliation.");
}
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
	if (stat.isSymbolicLink() || !stat.isDirectory()) stop();
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
function json(value: unknown): string {
	const ancestors = new Set<object>();
	function validate(input: unknown): void {
		if (input === null || typeof input === "string" || typeof input === "boolean") return;
		if (typeof input === "number" && Number.isFinite(input)) return;
		if (typeof input !== "object" || ancestors.has(input)) stop();
		ancestors.add(input);
		if (Array.isArray(input)) {
			if (Reflect.ownKeys(input).length !== input.length + 1) stop();
			for (let n = 0; n < input.length; n++) {
				const descriptor = Object.getOwnPropertyDescriptor(input, String(n));
				if (!descriptor || !("value" in descriptor)) stop();
				validate(descriptor.value);
			}
		} else {
			if (
				Object.getPrototypeOf(input) !== Object.prototype &&
				Object.getPrototypeOf(input) !== null
			)
				stop();
			for (const key of Reflect.ownKeys(input)) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key);
				if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) stop();
				validate(descriptor.value);
			}
		}
		ancestors.delete(input);
	}
	validate(value);
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > maxPayloadBytes) stop();
	return text;
}

/** Existing private trusted root; no automatic replay or remote verification. */
export function createIssueConfirmationStore(root: string) {
	const base = resolve(root);
	function sessionPath(sessionId: string): string {
		if (!validId(sessionId)) stop();
		directory(base);
		return join(base, hash(sessionId));
	}
	function read(path: string): unknown | null {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > maxRecordBytes)
				stop();
			const fd = openSync(path, "r+");
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
				fsyncSync(fd);
				return value;
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if (absent(error)) return null;
			return stop();
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
			hash(json(value.payload)) !== value.digest
		)
			stop();
		return {
			sessionId: value.sessionId,
			operationId: value.operationId,
			digest: value.digest,
			payload: value.payload,
		};
	}
	function scan(sessionId: string) {
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
			const prepared = parsePrepared(read(join(path, name)));
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
			const raw = read(join(path, `${n}.intent`));
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
			const completed = read(join(path, `${n}.completed`));
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
				json(completed.result);
				op.completed = { result: completed.result };
				completions++;
			}
		}
		if (names.filter((name) => name.endsWith(".completed")).length !== completions) stop();
		flushDirectory(path);
		flushDirectory(base);
		return { path, ops, revisions, pending };
	}
	async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch {
			return stop();
		}
	}
	return {
		prepare(
			sessionId: string,
			operationId: string,
			payload: unknown,
		): Promise<{ digest: string; payload: unknown }> {
			return guarded(() => {
				if (!validOperation(operationId)) stop();
				const encoded = json(payload);
				const digest = hash(encoded);
				const snapshot: unknown = JSON.parse(encoded);
				const state = scan(sessionId);
				const existing = state.ops.get(operationId);
				if (existing) {
					if (existing.prepared.digest !== digest) stop();
					return { digest, payload: existing.prepared.payload };
				}
				if (state.pending || state.ops.size >= maxOperations) stop();
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
					if (!winner || winner.prepared.digest !== digest) stop();
				}
				return { digest, payload: snapshot };
			});
		},
		get(
			sessionId: string,
			operationId: string,
		): Promise<{ digest: string; payload: unknown } | null> {
			return guarded(() => {
				if (!validOperation(operationId)) stop();
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
		): Promise<unknown> {
			return guarded(async () => {
				if (
					!validOperation(operationId) ||
					!validToolCallId(toolCallId) ||
					typeof digest !== "string" ||
					!/^[a-f0-9]{64}$/.test(digest) ||
					typeof run !== "function"
				)
					stop();
				const state = scan(sessionId);
				const op = state.ops.get(operationId);
				if (!op || op.prepared.digest !== digest) stop();
				if (op.intent) {
					if (op.intent.toolCallId !== toolCallId || !op.completed) stop();
					return op.completed.result;
				}
				if (state.pending || state.revisions >= maxOperations) stop();
				const intent = { sessionId, operationId, digest, toolCallId };
				const revision = state.revisions + 1;
				try {
					write(join(state.path, `${revision}.intent`), intent, state.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") stop();
					throw error;
				}
				let encodedResult: string;
				try {
					encodedResult = json(await run());
				} catch {
					return stop();
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

export type IssueConfirmationStore = ReturnType<typeof createIssueConfirmationStore>;
