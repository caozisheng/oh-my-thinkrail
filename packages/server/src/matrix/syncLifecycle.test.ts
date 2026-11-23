import { expect, test } from "bun:test";
import type { MatrixConnectionInput } from "@thinkrail/contracts";
import {
	emptyProjection,
	type MatrixHostPort,
	type MatrixProjectionState,
	type MatrixProjectionStore,
	type MatrixSessionTarget,
} from "./projection";
import {
	createMatrixService,
	type MatrixCredentialStore,
	type MatrixPersistence,
	type MatrixRecord,
} from "./service";

const input: MatrixConnectionInput = {
	operationId: "matrix_sync_test_01",
	homeserver: "https://matrix.example",
	botUserId: "@bot:example.org",
	controllerUserId: "@owner:example.org",
	plaintextAcknowledged: true,
	mode: "access-token",
	accessToken: "fixture-token",
};
const roomId = "!session:example.org";
const session: MatrixSessionTarget = {
	projectId: "project-1",
	projectName: "Project",
	workspaceId: "workspace-1",
	workspaceName: "Workspace",
	sessionId: "session-1",
	title: "Session",
	state: {
		execution: "idle",
		runId: null,
		needsInput: null,
		backgroundWork: false,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
	},
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function gate() {
	const started = deferred<void>();
	const response = deferred<Response>();
	return {
		started: started.promise,
		respond(body: unknown) {
			response.resolve(Response.json(body));
		},
		async fetch() {
			started.resolve();
			return response.promise;
		},
	};
}

test.each([
	{
		name: "uploads the bot filter, ignores baseline timeline, dispatches live text once, and stops sync",
		blockReconciliation: false,
	},
	{
		name: "queues live timeline after Prepared while its reconciliation is blocked, ignores baseline, and dispatches after unblock",
		blockReconciliation: true,
	},
	{
		name: "dispatches live input between transcript steps before a multi-session pass completes",
		blockReconciliation: true,
		blockTranscript: true,
	},
])("SDK bridge $name", async ({ blockReconciliation, blockTranscript }) => {
	const calls: { method: string; url: string; body?: unknown }[] = [];
	const firstSync = gate();
	const laterSync = gate();
	const liveSync = gate();
	const pendingSync = gate();
	let syncNumber = 0;
	let saved: MatrixRecord | null = null;
	let projection: MatrixProjectionState = {
		...emptyProjection(),
		identity: {
			bot: input.botUserId,
			homeserver: input.homeserver,
			controller: input.controllerUserId,
		},
		rootRoomId: "!root:example.org",
		controlRoomId: "!control:example.org",
		projects: { "project-1": { roomId: "!project:example.org" } },
		sessions: {
			"session-1": {
				projectId: "project-1",
				workspaceId: "workspace-1",
				sessionId: "session-1",
				projectRoomId: "!project:example.org",
				roomId,
				sent: [],
			},
		},
	};
	const store: MatrixProjectionStore = {
		async load() {
			return structuredClone(projection);
		},
		async save(value) {
			projection = structuredClone(value);
		},
	};
	let dispatches = 0;
	let transcripts = 0;
	const reconciliationStarted = deferred<void>();
	const reconciliationUnblocked = deferred<void>();
	const host: MatrixHostPort = {
		async catalog() {
			reconciliationStarted.resolve();
			if (blockReconciliation && !blockTranscript) await reconciliationUnblocked.promise;
			return blockTranscript ? [session, session, session, session] : [session];
		},
		async transcript() {
			transcripts++;
			if (blockTranscript && transcripts === 1) await reconciliationUnblocked.promise;
			return [];
		},
		async prompt(target, text, followup) {
			expect(target.sessionId).toBe("session-1");
			expect(text).toBe("live message");
			expect(followup).toBe(false);
			if (blockTranscript) expect(transcripts).toBeLessThan(2);
			dispatches++;
		},
		async stop() {},
		async interaction() {
			return null;
		},
		async answer() {},
	};
	const credentials: MatrixCredentialStore = {
		async get() {
			return "fixture-token";
		},
		async set() {},
		async delete() {},
	};
	const persistence: MatrixPersistence = {
		async load() {
			return structuredClone(saved);
		},
		async save(value) {
			saved = structuredClone(value);
		},
	};
	const fetchFn = Object.assign(
		async (resource: URL | RequestInfo, init?: RequestInit) => {
			const url = String(resource);
			const method = init?.method ?? "GET";
			let body: unknown;
			if (typeof init?.body === "string") {
				try {
					body = JSON.parse(init.body);
				} catch {}
			}
			calls.push({ method, url, body });
			if (url.endsWith("/whoami"))
				return Response.json({ user_id: input.botUserId, device_id: "device" });
			if (url.endsWith("/versions")) return Response.json({ versions: ["v1.11"] });
			if (url.includes("/pushrules/")) return Response.json({ global: {} });
			if (url.endsWith("/filter")) return Response.json({ filter_id: "bot-filter" });
			if (url.includes("/sync?")) {
				const current = syncNumber++;
				return current === 0
					? firstSync.fetch()
					: current === 1
						? laterSync.fetch()
						: current === 2
							? liveSync.fetch()
							: pendingSync.fetch();
			}
			if (url.endsWith("/state"))
				return Response.json([{ type: "m.room.join_rules", content: { join_rule: "invite" } }]);
			if (url.includes("/state/")) return Response.json({ event_id: "$state" });
			if (url.endsWith("/invite")) return Response.json({});
			if (url.endsWith("/capabilities")) return Response.json({ capabilities: {} });
			if (url.includes("/send/m.room.message/")) return Response.json({ event_id: "$sent" });
			if (url.includes("/send_state/")) return Response.json({ event_id: "$state" });
			if (url.includes("/redact/")) return Response.json({ event_id: "$redact" });
			if (url.includes("/members")) return Response.json({ chunk: [] });
			throw new Error(`Unexpected Matrix request: ${method} ${url}`);
		},
		{ preconnect() {} },
	);
	const diagnostics: string[] = [];
	const service = createMatrixService({
		diagnostic: (code) => diagnostics.push(code),
		credentials,
		persistence,
		fetchFn,
		bridge: { host, store },
	});
	const connected = await service.configure(input);
	expect(connected.phase).toBe("syncing");
	await Promise.race([
		firstSync.started,
		new Promise<never>((_, reject) =>
			setTimeout(
				() =>
					reject(
						new Error(
							`Sync did not start: ${calls.map((call) => `${call.method} ${call.url}`).join(" | ")}`,
						),
					),
				1500,
			),
		),
	]);
	const filterCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/filter"));
	expect(filterCall?.url).toBe(
		`https://matrix.example/_matrix/client/v3/user/${encodeURIComponent(input.botUserId)}/filter`,
	);
	expect(filterCall?.body).toBeTruthy();

	firstSync.respond({
		next_batch: "baseline",
		rooms: {
			join: {
				[roomId]: {
					timeline: {
						events: [
							{
								type: "m.room.message",
								event_id: "$baseline",
								sender: input.controllerUserId,
								content: { msgtype: "m.text", body: "baseline message" },
							},
						],
					},
					state: { events: [] },
					ephemeral: { events: [] },
					account_data: { events: [] },
				},
			},
		},
	});
	await laterSync.started;
	// catalog() is reached by the reconciliation triggered by Prepared, so this
	// proves Prepared has occurred without waiting for that reconciliation to finish.
	await reconciliationStarted.promise;
	if (!blockReconciliation) await service.sync();
	expect(dispatches).toBe(0);

	laterSync.respond({ next_batch: "live", rooms: {} });
	await liveSync.started;
	if (!blockReconciliation) await service.sync();
	liveSync.respond({
		next_batch: "live-2",
		rooms: {
			join: {
				[roomId]: {
					timeline: {
						events: [
							{
								type: "m.room.message",
								event_id: "$live",
								sender: input.controllerUserId,
								content: { msgtype: "m.text", body: "live message" },
							},
							{
								type: "m.room.message",
								event_id: "$bot-echo",
								sender: input.botUserId,
								content: { msgtype: "m.text", body: "projected bot output" },
							},
						],
					},
					state: { events: [] },
					ephemeral: { events: [] },
					account_data: { events: [] },
				},
			},
		},
	});
	if (blockReconciliation) {
		// The next /sync starts only after the SDK has processed the live timeline.
		// The shared bridge queue must retain it, not classify it as baseline while
		// the Prepared-triggered reconciliation is still awaiting catalog().
		await pendingSync.started;
		expect(service.status().phase).toBe("syncing");
		expect(dispatches).toBe(0);
		expect(diagnostics).toContain("inbound-queued");
		expect(diagnostics).toContain("reconcile-start");
		expect(diagnostics).not.toContain("dispatch-started");
		reconciliationUnblocked.resolve();
	}
	await new Promise<void>((resolve, reject) => {
		const deadline = setTimeout(
			() =>
				reject(
					new Error(
						`Live dispatch did not complete; syncs=${syncNumber}; calls=${calls.filter((call) => call.url.includes("/sync?")).length}; phase=${service.status().phase}; inbox=${JSON.stringify(projection.inbox)}`,
					),
				),
			2000,
		);
		const poll = () => {
			if (dispatches === 1) {
				clearTimeout(deadline);
				resolve();
			} else setTimeout(poll, 0);
		};
		poll();
	});
	expect(dispatches).toBe(1);
	await service.sync();
	for (const code of [
		"sync-prepared",
		"sync-online",
		"timeline-controller-text",
		"inbound-queued",
		"inbound-started",
		"dispatch-started",
		"dispatch-accepted",
		"reconcile-start",
	])
		expect(diagnostics).toContain(code);
	// Bot output echoed by /sync is routine, not an unauthorized sender attempt.
	expect(diagnostics).not.toContain("timeline-rejected-sender");
	expect(diagnostics.filter((code) => code === "sync-online")).toHaveLength(1);
	expect(diagnostics).toContain("reconcile-end");
	expect(diagnostics.filter((code) => code === "reconcile-start")).toHaveLength(1);
	expect(diagnostics.every((code) => /^[a-z]+(?:-[a-z]+)*$/.test(code))).toBe(true);
	await service.stop();
	expect(calls.filter((call) => call.url.includes("/sync?"))).toHaveLength(4);
	pendingSync.respond({ next_batch: "stopped", rooms: {} });
	await Promise.resolve();
	expect(calls.filter((call) => call.url.includes("/sync?"))).toHaveLength(4);
});
