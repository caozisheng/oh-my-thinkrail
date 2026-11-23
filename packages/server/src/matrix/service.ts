import { createHash, randomUUID } from "node:crypto";
import {
	canonicalMatrixHomeserver,
	isMatrixConnectionInput,
	isMatrixUserId,
	type MatrixConnectionInput,
	type MatrixErrorCode,
	type MatrixStatus,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { ClientEvent, type MatrixClient, RoomEvent, SyncState } from "matrix-js-sdk";
import { createMatrixClient } from "./client";
import { matrixFetchFor } from "./fetch";
import {
	createMatrixProjection,
	type MatrixHostPort,
	type MatrixProjectionStore,
} from "./projection";

export interface MatrixCredentialStore {
	get(id: string): Promise<string | null>;
	set(id: string, value: string): Promise<void>;
	delete(id: string): Promise<void>;
}

export interface MatrixRecord {
	homeserver: string;
	botUserId: string;
	controllerUserId: string;
	mode: "password" | "access-token";
	credentialId?: string;
	cleanupCredentialIds: string[];
	operation?: { id: string; fingerprint: string; phase: "pending" | "completed" };
}

export interface MatrixPersistence {
	load(): Promise<MatrixRecord | null>;
	save(record: MatrixRecord | null): Promise<void>;
}

export interface MatrixService {
	status(): MatrixStatus;
	restore(): Promise<MatrixStatus>;
	sync(): Promise<MatrixStatus>;
	configure(input: MatrixConnectionInput): Promise<MatrixStatus>;
	disconnect(): Promise<MatrixStatus>;
	connectPublisher(publish: (status: MatrixStatus) => void): () => void;
	stop(): Promise<void>;
}

export interface MatrixServiceOptions {
	credentials: MatrixCredentialStore;
	persistence: MatrixPersistence;
	fetchFn?: typeof globalThis.fetch;
	bridge?: { host: MatrixHostPort; store: MatrixProjectionStore };
}

class MatrixFailure extends CodedError {
	readonly matrixCode: MatrixErrorCode;
	constructor(code: MatrixErrorCode) {
		super("RESOURCE_UNAVAILABLE", "Matrix operation failed.");
		this.matrixCode = code;
	}
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validRecord(value: MatrixRecord): boolean {
	return (
		canonicalMatrixHomeserver(value.homeserver) === value.homeserver &&
		isMatrixUserId(value.botUserId) &&
		isMatrixUserId(value.controllerUserId) &&
		value.botUserId !== value.controllerUserId &&
		["password", "access-token"].includes(value.mode) &&
		(value.credentialId === undefined || uuid.test(value.credentialId)) &&
		Array.isArray(value.cleanupCredentialIds) &&
		value.cleanupCredentialIds.every((id) => uuid.test(id)) &&
		(!value.operation ||
			(/^[a-zA-Z0-9_-]{1,128}$/.test(value.operation.id) &&
				/^[a-f0-9]{64}$/.test(value.operation.fingerprint) &&
				["pending", "completed"].includes(value.operation.phase)))
	);
}

export function createMatrixService(options: MatrixServiceOptions): MatrixService {
	let record: MatrixRecord | null = null;
	let client: MatrixClient | null = null;
	let phase: MatrixStatus["phase"] = "disconnected";
	let error: MatrixErrorCode | undefined;
	let active: Promise<MatrixStatus> | undefined;
	let disconnecting: Promise<MatrixStatus> | undefined;
	let stopped = false;
	let epoch = 0;
	let storageFailed = false;
	let counts = { projects: 0, sessions: 0, backfilled: 0 };
	let stopSync: (() => void) | undefined;
	let reconcile: (() => Promise<void>) | undefined;
	const subscribers = new Set<(status: MatrixStatus) => void>();
	const snapshot = (): MatrixStatus => ({
		phase,
		hasCredential: Boolean(record?.credentialId),
		...counts,
		...(record
			? {
					homeserver: record.homeserver,
					botUserId: record.botUserId,
					controllerUserId: record.controllerUserId,
					mode: record.mode,
				}
			: {}),
		...(record?.operation ? { operationId: record.operation.id } : {}),
		...(error ? { error } : {}),
	});
	const publish = () => {
		for (const subscriber of subscribers) subscriber(snapshot());
	};
	const save = async (next: MatrixRecord | null) => {
		try {
			await options.persistence.save(next ? structuredClone(next) : null);
		} catch {
			storageFailed = true;
			throw new MatrixFailure("storage");
		}
		record = next;
	};
	const load = options.persistence
		.load()
		.then((value) => {
			if (value && !validRecord(value)) throw new MatrixFailure("storage");
			record = value;
			phase = value?.credentialId ? "paused" : "disconnected";
			if (value?.operation?.phase === "pending") {
				phase = "error";
				error = "reconciliation-required";
			}
			publish();
		})
		.catch(() => {
			storageFailed = true;
			phase = "error";
			error = "storage";
			publish();
		});
	const check = (expected: number) => {
		if (stopped || epoch !== expected) throw new MatrixFailure("busy");
		if (storageFailed) throw new MatrixFailure("storage");
	};
	const cleanup = async () => {
		if (!record?.cleanupCredentialIds.length) return;
		for (const id of record.cleanupCredentialIds) {
			try {
				await options.credentials.delete(id);
			} catch {
				throw new MatrixFailure("credentials");
			}
		}
		await save({ ...record, cleanupCredentialIds: [] });
	};
	const makeClient = (homeserver: string, token?: string, userId?: string) =>
		createMatrixClient({
			baseUrl: homeserver,
			fetchFn:
				options.fetchFn ??
				matrixFetchFor(homeserver, process.env.THINKRAIL_E2E_ISOLATION !== undefined),
			...(token ? { accessToken: token } : {}),
			...(userId ? { userId } : {}),
			...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
		});
	const verify = async (candidate: MatrixClient, userId: string) => {
		try {
			if ((await candidate.whoami()).user_id !== userId)
				throw new MatrixFailure("identity-mismatch");
		} catch (cause) {
			throw cause instanceof MatrixFailure ? cause : new MatrixFailure("authentication");
		}
	};
	const run = (work: (expected: number) => Promise<MatrixStatus>) => {
		if (active || disconnecting || stopped) return Promise.reject(new MatrixFailure("busy"));
		const expected = ++epoch;
		let task: Promise<MatrixStatus>;
		task = work(expected)
			.catch((cause) => {
				if (epoch === expected) {
					phase = "error";
					error = cause instanceof MatrixFailure ? cause.matrixCode : "network";
					publish();
				}
				throw cause instanceof MatrixFailure ? cause : new MatrixFailure("network");
			})
			.finally(() => {
				if (active === task) active = undefined;
			});
		active = task;
		return task;
	};
	const startBridge = (candidate: MatrixClient) => {
		stopSync?.();
		if (!options.bridge || !record) return;
		const bound = record;
		let online = false;
		let disposed = false;
		let baseline = true;
		let queue = Promise.resolve();
		const projection = createMatrixProjection({
			client: candidate,
			controller: bound.controllerUserId,
			bot: bound.botUserId,
			homeserver: bound.homeserver,
			...options.bridge,
			allowed: () =>
				!disposed &&
				!stopped &&
				client === candidate &&
				record?.credentialId === bound.credentialId,
		});
		const enqueue = (work: () => Promise<void>) => {
			queue = queue.then(work).catch(() => {
				if (!disposed) {
					phase = "error";
					error = "sync";
					publish();
				}
			});
			return queue;
		};
		reconcile = () =>
			enqueue(async () => {
				if (!online || disposed) return;
				counts = await projection.reconcile();
				phase = "connected";
				error = undefined;
				publish();
			});
		candidate.on(ClientEvent.Sync, (state) => {
			if (disposed) return;
			if (state === SyncState.Prepared || state === SyncState.Syncing) {
				const wasOnline = online;
				online = true;
				if (!wasOnline) {
					baseline = true;
					void reconcile?.().then(() => {
						baseline = false;
					});
				}
			} else {
				online = false;
				baseline = true;
				phase = "paused";
				publish();
			}
		});
		candidate.on(RoomEvent.Timeline, (event, room, toStart) => {
			if (
				disposed ||
				!room ||
				toStart ||
				event.getType() !== "m.room.message" ||
				event.getSender() !== bound.controllerUserId
			)
				return;
			const content = event.getContent();
			if (typeof content.body !== "string" || content.msgtype !== "m.text") return;
			const id = event.getId();
			if (!id) return;
			const historical = baseline || !online;
			void enqueue(() =>
				projection.receive({
					id,
					roomId: room.roomId,
					sender: bound.controllerUserId,
					text: content.body,
					historical,
					replacement: Boolean(content["m.relates_to"]?.rel_type === "m.replace"),
				}),
			);
		});
		const timer = setInterval(() => void reconcile?.(), 5000);
		timer.unref?.();
		stopSync = () => {
			disposed = true;
			clearInterval(timer);
			candidate.stopClient();
			reconcile = undefined;
		};
		phase = "syncing";
		publish();
		void candidate.startClient({ initialSyncLimit: 50 }).catch(() => {
			phase = "error";
			error = "sync";
			publish();
		});
	};
	return {
		status: snapshot,
		async sync() {
			if (!client) throw new MatrixFailure("authentication");
			await reconcile?.();
			return snapshot();
		},
		connectPublisher(subscriber) {
			subscribers.add(subscriber);
			subscriber(snapshot());
			return () => subscribers.delete(subscriber);
		},
		restore() {
			if (active) return active;
			if (client) return Promise.resolve(snapshot());
			return run(async (expected) => {
				await load;
				check(expected);
				if (record?.operation?.phase === "pending")
					throw new MatrixFailure("reconciliation-required");
				await cleanup();
				check(expected);
				if (!record?.credentialId) return snapshot();
				const saved = record;
				const credentialId = saved.credentialId;
				if (!credentialId) return snapshot();
				let token: string | null;
				try {
					token = await options.credentials.get(credentialId);
				} catch {
					throw new MatrixFailure("credentials");
				}
				check(expected);
				if (!token) throw new MatrixFailure("credentials");
				const candidate = makeClient(saved.homeserver, token, saved.botUserId);
				try {
					await verify(candidate, saved.botUserId);
					check(expected);
				} catch (cause) {
					candidate.stopClient();
					throw cause;
				}
				client?.stopClient();
				client = candidate;
				phase = "connected";
				error = undefined;
				publish();
				startBridge(candidate);
				return snapshot();
			});
		},
		configure(input) {
			if (!isMatrixConnectionInput(input))
				return Promise.reject(new MatrixFailure("invalid-input"));
			const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			return run(async (expected) => {
				await load;
				check(expected);
				if (record?.operation?.id === input.operationId) {
					if (
						record.operation.fingerprint !== fingerprint ||
						record.operation.phase !== "completed"
					)
						throw new MatrixFailure("reconciliation-required");
					return snapshot();
				}
				if (record?.operation?.phase === "pending")
					throw new MatrixFailure("reconciliation-required");
				await cleanup();
				check(expected);
				const homeserver = canonicalMatrixHomeserver(input.homeserver);
				if (!homeserver) throw new MatrixFailure("invalid-input");
				const previous = record;
				const base = {
					homeserver,
					botUserId: input.botUserId,
					controllerUserId: input.controllerUserId,
					mode: input.mode,
				};
				await save({
					...(previous ?? base),
					cleanupCredentialIds: [],
					operation: { id: input.operationId, fingerprint, phase: "pending" },
				});
				check(expected);
				phase = "authenticating";
				error = undefined;
				publish();
				let token: string;
				if (input.mode === "password") {
					const loginClient = makeClient(homeserver);
					try {
						const login = await loginClient.login("m.login.password", {
							identifier: { type: "m.id.user", user: input.botUserId },
							password: input.password,
						});
						if (login.user_id !== input.botUserId) throw new MatrixFailure("identity-mismatch");
						token = login.access_token;
					} catch (cause) {
						await save(previous);
						throw cause instanceof MatrixFailure ? cause : new MatrixFailure("authentication");
					} finally {
						loginClient.stopClient();
					}
				} else token = input.accessToken;
				check(expected);
				if (typeof token !== "string" || !/^[!-~]{1,4096}$/.test(token))
					throw new MatrixFailure("authentication");
				const candidate = makeClient(homeserver, token, input.botUserId);
				try {
					try {
						await verify(candidate, input.botUserId);
					} catch (cause) {
						await save(previous);
						throw cause;
					}
					check(expected);
					const id = randomUUID();
					if (!record) throw new MatrixFailure("storage");
					await save({ ...record, cleanupCredentialIds: [id] });
					check(expected);
					try {
						await options.credentials.set(id, token);
					} catch {
						throw new MatrixFailure("credentials");
					}
					check(expected);
					await save({
						...base,
						credentialId: id,
						cleanupCredentialIds: previous?.credentialId ? [previous.credentialId] : [],
						operation: { id: input.operationId, fingerprint, phase: "completed" },
					});
					check(expected);
					client?.stopClient();
					client = candidate;
					await cleanup();
					check(expected);
					phase = "connected";
					error = undefined;
					publish();
					startBridge(candidate);
					return snapshot();
				} catch (cause) {
					candidate.stopClient();
					throw cause;
				}
			});
		},
		disconnect() {
			if (disconnecting) return disconnecting;
			++epoch;
			stopSync?.();
			stopSync = undefined;
			client?.stopClient();
			client = null;
			const pending = active;
			const task = (async () => {
				await load;
				try {
					await pending;
				} catch {}

				if (storageFailed) throw new MatrixFailure("storage");
				if (record) {
					const ids = [
						...record.cleanupCredentialIds,
						...(record.credentialId ? [record.credentialId] : []),
					];
					const detached = { ...record, cleanupCredentialIds: [...new Set(ids)] };
					delete detached.credentialId;
					await save(detached);
					await cleanup();
				}
				await save(null);
				phase = "disconnected";
				error = undefined;
				publish();
				return snapshot();
			})()
				.catch((cause) => {
					phase = "error";
					error = cause instanceof MatrixFailure ? cause.matrixCode : "credentials";
					publish();
					throw cause;
				})
				.finally(() => {
					disconnecting = undefined;
				});
			disconnecting = task;
			return task;
		},
		async stop() {
			stopped = true;
			++epoch;
			stopSync?.();
			stopSync = undefined;
			client?.stopClient();
			client = null;
			await active?.catch(() => undefined);
			await disconnecting?.catch(() => undefined);
			phase = record?.credentialId ? "paused" : "disconnected";
			publish();
		},
	};
}
