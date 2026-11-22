import { expect, test } from "bun:test";
import { verifyMatrixAccessToken } from "./client";

function fetchFixture(identity: Record<string, unknown>) {
	const requests: string[] = [];
	const fetchFn = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
		requests.push(String(input));
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
		return Response.json(identity);
	}, { preconnect() {} });
	return { fetchFn, requests };
}

test("verifies a token and returns only the canonical bot identity", async () => {
	const fixture = fetchFixture({ user_id: "@bot:example", device_id: "device-1" });
	expect(
		await verifyMatrixAccessToken({
			baseUrl: "https://matrix.example/",
			accessToken: "fixture-token",
			userId: "@bot:example",
			fetchFn: fixture.fetchFn,
		}),
	).toEqual({ userId: "@bot:example", deviceId: "device-1" });
	expect(fixture.requests).toEqual(["https://matrix.example/_matrix/client/v3/account/whoami"]);
});

test("rejects an identity mismatch and unsafe homeserver URLs before fetching", async () => {
	const fixture = fetchFixture({ user_id: "@other:example" });
	await expect(
		verifyMatrixAccessToken({
			baseUrl: "https://matrix.example",
			accessToken: "fixture-token",
			userId: "@bot:example",
			fetchFn: fixture.fetchFn,
		}),
	).rejects.toThrow("identity mismatch");
	for (const baseUrl of [
		"http://matrix.example",
		"https://user@matrix.example",
		"https://matrix.example/private",
		"https://matrix.example?next=private",
	]) {
		await expect(
			verifyMatrixAccessToken({ baseUrl, accessToken: "fixture-token", fetchFn: fixture.fetchFn }),
		).rejects.toThrow("Invalid Matrix homeserver URL");
	}
	expect(fixture.requests).toHaveLength(1);
});
