import { expect, test } from "bun:test";
import { createMatrixCredentials } from "./matrixCredentials";

test("Matrix credentials use a distinct service and a profile-scoped vault key", async () => {
	const values = new Map<string, string>();
	const calls: Record<string, unknown>[] = [];
	const secrets = {
		async get(key: Record<string, unknown>) {
			calls.push(key);
			return values.get(JSON.stringify(key)) ?? null;
		},
		async set(input: Record<string, unknown>) {
			calls.push(input);
			const key = JSON.stringify({ service: input.service, name: input.name });
			values.set(key, String(input.value));
		},
		async delete(key: Record<string, unknown>) {
			calls.push(key);
			return values.delete(JSON.stringify(key));
		},
	};
	const store = createMatrixCredentials({
		namespace: "profile:default",
		secrets,
		platform: "win32",
	});
	const id = "123e4567-e89b-42d3-a456-426614174000";
	expect(await store.get(id)).toBeNull();
	await store.set(id, "matrix-access-token");
	expect(await store.get(id)).toBe("matrix-access-token");
	await store.delete(id);
	expect(await store.get(id)).toBeNull();
	expect(calls.some((call) => call.service === "ThinkRailMatrix")).toBe(true);
	expect(calls.find((call) => call.value)?.persist).toBe("local");
	expect(JSON.stringify(calls)).not.toContain("profile:default");
});
