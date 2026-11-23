import { expect, test } from "bun:test";
import type { MatrixConnectionInput } from "@thinkrail/contracts";
import {
	createMatrixService,
	type MatrixCredentialStore,
	type MatrixPersistence,
	type MatrixRecord,
} from "./service";

const input: MatrixConnectionInput = {
	operationId: "matrix_test_01",
	homeserver: "https://matrix.example",
	botUserId: "@bot:example.org",
	controllerUserId: "@owner:example.org",
	plaintextAcknowledged: true,
	mode: "password",
	password: "one-time-password",
};

function fixture(
	options: { whoamiUserId?: string; failVaultSet?: boolean; loginError?: boolean } = {},
) {
	const secrets = new Map<string, string>();
	let saved: MatrixRecord | null = null;
	const calls: string[] = [];
	const credentials: MatrixCredentialStore = {
		async get(id) {
			return secrets.get(id) ?? null;
		},
		async set(id, value) {
			calls.push("vault:set");
			if (options.failVaultSet) throw new Error("secret");
			secrets.set(id, value);
		},
		async delete(id) {
			calls.push("vault:delete");
			secrets.delete(id);
		},
	};
	const persistence: MatrixPersistence = {
		async load() {
			return structuredClone(saved);
		},
		async save(record) {
			calls.push("persistence:save");
			saved = structuredClone(record);
		},
	};
	const fetchFn = Object.assign(
		async (resource: URL | RequestInfo, init?: RequestInit) => {
			const url = String(resource);
			if (url.endsWith("/login")) {
				calls.push("login");
				if (options.loginError)
					return Response.json({ errcode: "M_FORBIDDEN", error: "bad password" }, { status: 403 });
				return Response.json({
					user_id: input.botUserId,
					access_token: "ephemeral-token",
					device_id: "d1",
				});
			}
			if (url.endsWith("/whoami")) {
				calls.push(`whoami:${new Headers(init?.headers).get("authorization")}`);
				return Response.json({ user_id: options.whoamiUserId ?? input.botUserId, device_id: "d1" });
			}
			throw new Error("Unexpected fixture endpoint");
		},
		{ preconnect() {} },
	);
	const make = () => createMatrixService({ credentials, persistence, fetchFn });
	return { service: make(), make, credentials, calls, secrets, readRecord: () => saved };
}

test("password login stores only access token and persists credential-free metadata", async () => {
	const f = fixture();
	const status = await f.service.configure(input);
	expect(status.phase).toBe("connected");
	expect(status.hasCredential).toBe(true);
	expect(JSON.stringify(status)).not.toContain("ephemeral-token");
	expect(JSON.stringify(f.readRecord())).not.toContain("one-time-password");
	const saved = f.readRecord();
	if (!saved?.credentialId) throw new Error("Expected credential metadata");
	expect(f.secrets.get(saved.credentialId)).toBe("ephemeral-token");
});

test("identity mismatch and vault failure never persist an active binding", async () => {
	const mismatch = fixture({ whoamiUserId: "@other:example.org" });
	await expect(mismatch.service.configure(input)).rejects.toThrow();
	expect(mismatch.readRecord()?.credentialId).toBeUndefined();
	const failedVault = fixture({ failVaultSet: true });
	await expect(failedVault.service.configure(input)).rejects.toThrow();
	expect(failedVault.readRecord()?.credentialId).toBeUndefined();
});

test("disconnect removes metadata and deletes the saved token", async () => {
	const f = fixture();
	await f.service.configure(input);
	const saved = f.readRecord();
	if (!saved?.credentialId) throw new Error("Expected credential metadata");
	expect((await f.service.disconnect()).phase).toBe("disconnected");
	expect(f.secrets.has(saved.credentialId)).toBe(false);
});

test("restores and revalidates a vault-backed connection after restart", async () => {
	const f = fixture();
	await f.service.configure(input);
	await f.service.stop();
	const restarted = f.make();
	expect((await restarted.restore()).phase).toBe("connected");
	expect(f.calls.filter((call) => call === "login")).toHaveLength(1);
});

test("successful operation replay is idempotent and changed input is refused", async () => {
	const f = fixture();
	await f.service.configure(input);
	await f.service.configure(input);
	expect(f.calls.filter((call) => call === "login")).toHaveLength(1);
	await expect(
		f.service.configure({ ...input, controllerUserId: "@other:example.org" }),
	).rejects.toThrow();
});

test("private HTTP consent survives restart and remains bound to the exact origin", async () => {
	const f = fixture();
	const homeserver = "http://matrix.example:9527";
	const httpInput = { ...input, homeserver, networkConsent: { homeserver } };
	await expect(f.service.configure({ ...input, homeserver })).rejects.toThrow();
	await f.service.configure(httpInput);
	expect(f.readRecord()?.networkConsent).toEqual({ homeserver });
	await f.service.stop();
	expect((await f.make().restore()).phase).toBe("connected");
	await expect(
		f.make().configure({
			...httpInput,
			operationId: "another",
			homeserver: "http://matrix.example:9528",
		}),
	).rejects.toThrow();
});

test("definitive password rejection does not leave a retry-blocking pending fence", async () => {
	const f = fixture({ loginError: true });
	await expect(f.service.configure(input)).rejects.toThrow();
	expect(f.readRecord()?.operation).toBeUndefined();
	f.service.stop();
});
