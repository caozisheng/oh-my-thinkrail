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

test("SDK bridge uploads the bot filter, ignores baseline timeline, dispatches live text once, and stops sync", async () => {
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
	const host: MatrixHostPort = {
		async catalog() {
			return [session];
		},
		async transcript() {
			return [];
		},
		async prompt(target, text, followup) {
			expect(target.sessionId).toBe("session-1");
			expect(text).toBe("live message");
			expect(followup).toBe(false);
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
			if (url.endsWith("/capabilities")) return Response.json({ capabilities: {} });
			if (url.includes("/send/m.room.message/")) return Response.json({ event_id: "$sent" });
			if (url.includes("/send_state/")) return Response.json({ event_id: "$state" });
			if (url.includes("/redact/")) return Response.json({ event_id: "$redact" });
			if (url.includes("/members")) return Response.json({ chunk: [] });
			throw new Error(`Unexpected Matrix request: ${method} ${url}`);
		},
		{ preconnect() {} },
	);
	const service = createMatrixService({
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
	await service.sync();
	expect(dispatches).toBe(0);

	laterSync.respond({ next_batch: "live", rooms: {} });
	await liveSync.started;
	await service.sync();
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
						],
					},
					state: { events: [] },
					ephemeral: { events: [] },
					account_data: { events: [] },
				},
			},
		},
	});
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
	await service.stop();
	expect(calls.filter((call) => call.url.includes("/sync?"))).toHaveLength(4);
	pendingSync.respond({ next_batch: "stopped", rooms: {} });
	await Promise.resolve();
	expect(calls.filter((call) => call.url.includes("/sync?"))).toHaveLength(4);
});
