import { createHash, randomUUID } from "node:crypto";
import {
	canonicalMatrixHomeserver,
	isMatrixConnectionInput,
	isMatrixUserId,
	type MatrixConnectionInput,
	type MatrixErrorCode,
	type MatrixStatus,
	type SessionEventPayload,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { ClientEvent, type MatrixClient, RoomEvent, SyncState } from "matrix-js-sdk";
import { createMatrixClient } from "./client";
import { matrixFetchFor } from "./fetch";
import { createMatrixLiveEvents } from "./liveEvents";
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
	networkConsent?: { homeserver: string };
	cleanupCredentialIds: string[];
	operation?: { id: string; fingerprint: string; phase: "pending" | "completed" };
}

export interface MatrixPersistence {
	load(): Promise<MatrixRecord | null>;
	save(record: MatrixRecord | null): Promise<void>;
}

export interface MatrixService {
	status(): MatrixStatus;
	observe(payload: SessionEventPayload): void;
	stateChanged(): void;
	restore(): Promise<MatrixStatus>;
	sync(): Promise<MatrixStatus>;
	configure(input: MatrixConnectionInput): Promise<MatrixStatus>;
	disconnect(): Promise<MatrixStatus>;
	connectPublisher(publish: (status: MatrixStatus) => void): () => void;
	stop(): Promise<void>;
}

/** Closed classifications only: never attach event, identity, content or exception data. */
export type MatrixDiagnosticCode =
	| "sync-prepared"
	| "sync-online"
	| "sync-paused"
	| "timeline-controller-text"
	| "timeline-rejected-sender"
	| "timeline-unsupported"
	| "timeline-encrypted"
	| "inbound-queued"
	| "inbound-started"
	| "reconcile-start"
	| "reconcile-catalog"
	| "reconcile-root"
	| "reconcile-control"
	| "reconcile-project"
	| "reconcile-session"
	| "reconcile-transcript"
	| "reconcile-output"
	| "reconcile-end"
	| "reconcile-failed"
	| "unmapped-room"
	| "duplicate"
	| "historical"
	| "not-available"
	| "dispatch-started"
	| "dispatch-accepted"
	| "dispatch-unknown"
	| "control-room";

export interface MatrixServiceOptions {
	diagnostic?: (code: MatrixDiagnosticCode) => void;
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
		(value.networkConsent === undefined ||
			(Object.keys(value.networkConsent).length === 1 &&
				value.networkConsent.homeserver === value.homeserver)) &&
		(!value.homeserver.startsWith("http:") ||
			value.networkConsent?.homeserver === value.homeserver) &&
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
	// A diagnostics consumer must not change delivery or lifecycle behavior.
	const diagnostic = (code: MatrixDiagnosticCode) => {
		try {
			options.diagnostic?.(code);
		} catch {}
	};
	let record: MatrixRecord | null = null;
	let client: MatrixClient | null = null;
	let phase: MatrixStatus["phase"] = "disconnected";
	let error: MatrixErrorCode | undefined;
	let active: Promise<MatrixStatus> | undefined;
	let disconnecting: Promise<MatrixStatus> | undefined;
	let stopped = false;
	let epoch = 0;
	let storageFailed = false;
	let counts = { projects: 0, sessions: 0, backfilled: 0, pendingControls: 0 };
	let stopSync: (() => void) | undefined;
	let reconcile: (() => Promise<void>) | undefined;
	let liveEvents: ReturnType<typeof createMatrixLiveEvents> | undefined;
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
	const makeClient = (
		homeserver: string,
		token?: string,
		userId?: string,
		consent?: { homeserver: string },
	) =>
		createMatrixClient({
			baseUrl: homeserver,
			fetchFn: options.fetchFn ?? matrixFetchFor(homeserver, consent),
			...(token ? { accessToken: token } : {}),
			...(userId ? { userId } : {}),
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
		let initialPrepared = false;
		let reconnectBatch = false;
		let queue = Promise.resolve();
		let lastReconcileDiagnostic = -Infinity;
		let reconcileFailed = false;
		let syncDiagnostic: MatrixDiagnosticCode | undefined;
		const syncStateDiagnostic = (code: MatrixDiagnosticCode) => {
			if (syncDiagnostic !== code) diagnostic(code);
			syncDiagnostic = code;
		};
		const projection = createMatrixProjection({
			client: candidate,
			controller: bound.controllerUserId,
			bot: bound.botUserId,
			homeserver: bound.homeserver,
			...options.bridge,
			diagnostic,
			allowed: () =>
				!disposed &&
				!stopped &&
				client === candidate &&
				record?.credentialId === bound.credentialId,
		});
		const enqueue = (work: () => Promise<void>) => {
			queue = queue
				.then(() => {
					if (!disposed) return work();
					return undefined;
				})
				.catch(() => {
					if (!disposed) {
						phase = "error";
						error = "sync";
						publish();
					}
				});
			return queue;
		};
		const events = createMatrixLiveEvents({
			allowed: () => online && !disposed && !stopped && client === candidate,
			enqueue,
			stream: (sessionId, key, message, final) => projection.stream(sessionId, key, message, final),
			async reconcile() {
				if (!online || disposed) return;
				// Reconciliation runs every five seconds: sample routine cycles once a minute,
				// but always report a new failure and its recovery (never raw errors).
				const report = Date.now() - lastReconcileDiagnostic >= 60_000;
				if (report) {
					lastReconcileDiagnostic = Date.now();
					diagnostic("reconcile-start");
				}
				let next: typeof counts;
				try {
					next = await projection.reconcile();
					if (report || reconcileFailed) diagnostic("reconcile-end");
					reconcileFailed = false;
				} catch (cause) {
					if (!reconcileFailed) diagnostic("reconcile-failed");
					reconcileFailed = true;
					throw cause;
				}
				if (!online || disposed || stopped) return;
				counts = next;
				phase = "connected";
				error = undefined;
				publish();
			},
		});
		liveEvents = events;
		reconcile = () => events.sync();
		candidate.on(ClientEvent.Sync, (state) => {
			if (disposed) return;
			if (state === SyncState.Prepared || state === SyncState.Syncing) {
				const wasOnline = online;
				online = true;
				if (!initialPrepared && state === SyncState.Prepared) {
					initialPrepared = true;
					diagnostic("sync-prepared");
					baseline = false;
				} else if (reconnectBatch) {
					// Timeline events for this /sync were emitted before this state event.
					// Keep them historical, then admit events from the following batch.
					reconnectBatch = false;
					baseline = false;
				}
				syncStateDiagnostic("sync-online");
				if (!wasOnline) void events.sync();
			} else {
				if (online || initialPrepared) reconnectBatch = true;
				online = false;
				syncStateDiagnostic("sync-paused");
				events.pause();
				baseline = true;
				phase = "paused";
				publish();
			}
		});
		candidate.on(RoomEvent.Timeline, (event, room, toStart) => {
			if (disposed || !room || toStart) return;
			if (event.getType() === "m.room.encrypted") {
				diagnostic("timeline-encrypted");
				return;
			}
			if (event.getType() !== "m.room.message") {
				diagnostic("timeline-unsupported");
				return;
			}
			// Our projected output is echoed by /sync; it is not unauthorized input.
			if (event.getSender() === bound.botUserId) return;
			if (event.getSender() !== bound.controllerUserId) {
				diagnostic("timeline-rejected-sender");
				return;
			}
			const content = event.getContent();
			if (typeof content.body !== "string" || content.msgtype !== "m.text") {
				diagnostic("timeline-unsupported");
				return;
			}
			const id = event.getId();
			if (!id) {
				diagnostic("timeline-unsupported");
				return;
			}
			diagnostic("timeline-controller-text");
			const historical = baseline || !online;
			diagnostic("inbound-queued");
			// Projection owns serialization at bounded reconciliation checkpoints.
			// Do not put input behind the live-events drain's entire catalog pass.
			diagnostic("inbound-started");
			void projection
				.receive({
					id,
					matrixEvent: event,
					roomId: room.roomId,
					sender: bound.controllerUserId,
					text: content.body,
					historical,
					replacement: Boolean(content["m.relates_to"]?.rel_type === "m.replace"),
				})
				.catch(() => {
					if (!disposed) {
						phase = "error";
						error = "sync";
						publish();
					}
				});
		});
		const timer = setInterval(() => void events.sync(), 5000);
		timer.unref?.();
		stopSync = () => {
			disposed = true;
			events.dispose();
			if (liveEvents === events) liveEvents = undefined;
			clearInterval(timer);
			candidate.stopClient();
			reconcile = undefined;
		};
		phase = "syncing";
		publish();
		void candidate.startClient({ initialSyncLimit: 50 }).catch(() => {
			if (disposed || stopped) return;
			phase = "error";
			error = "sync";
			publish();
		});
	};
	return {
		status: snapshot,
		observe(payload) {
			liveEvents?.observe(payload);
		},
		stateChanged() {
			liveEvents?.stateChanged();
		},
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
				const candidate = makeClient(
					saved.homeserver,
					token,
					saved.botUserId,
					saved.networkConsent,
				);
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
					...(input.networkConsent
						? {
								networkConsent: {
									homeserver: input.networkConsent.homeserver,
								},
							}
						: {}),
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
					const loginClient = makeClient(homeserver, undefined, undefined, input.networkConsent);
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
				const candidate = makeClient(homeserver, token, input.botUserId, input.networkConsent);
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
