import { expect, test } from "bun:test";
import { createClient } from "matrix-js-sdk";

const quietLogger = {
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {},
	getChild() {
		return quietLogger;
	},
};

test("the SDK validates a bot token through whoami without browser storage", async () => {
	const calls: string[] = [];
	const client = createClient({
		baseUrl: "https://matrix.example",
		userId: "@bot:example",
		accessToken: "fixture-token",
		logger: quietLogger,
		fetchFn: Object.assign(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				calls.push(String(input));
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
				return Response.json({ user_id: "@bot:example", device_id: "fixture-device" });
			},
			{ preconnect() {} },
		),
	});
	expect(await client.whoami()).toEqual({ user_id: "@bot:example", device_id: "fixture-device" });
	expect(calls).toEqual(["https://matrix.example/_matrix/client/v3/account/whoami"]);
	client.stopClient();
});
