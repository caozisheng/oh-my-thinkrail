import { expect, test } from "bun:test";
import { matrixFetchFor, pinnedMatrixLookupResult } from "./fetch";
import { isPrivateMatrixAddress } from "./network";

test("private-network exception excludes metadata, loopback and reserved addresses", () => {
	for (const ip of ["192.168.110.137", "10.0.0.3", "172.16.0.2", "fd00::1", "::ffff:192.168.1.2"])
		expect(isPrivateMatrixAddress(ip)).toBe(true);
	for (const ip of [
		"127.0.0.1",
		"169.254.169.254",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"fe80::1",
		"::ffff:127.0.0.1",
	])
		expect(isPrivateMatrixAddress(ip)).toBe(false);
});

test("DNS pin adapter returns the Node lookup callback shape for all-address requests", () => {
	const address = { address: "192.168.110.137", family: 4 };
	expect(pinnedMatrixLookupResult(address, { all: true })).toEqual([null, [address]]);
	expect(pinnedMatrixLookupResult(address, {})).toEqual([null, address.address, address.family]);
});

test("HTTP requires exact-origin consent before any DNS or request", async () => {
	const origin = "http://matrix.example:9527";
	await expect(matrixFetchFor(origin)(`${origin}/_matrix/client/v3/login`)).rejects.toThrow(
		"destination refused",
	);
	await expect(
		matrixFetchFor(origin, { homeserver: "http://matrix.example:9528" })(
			`${origin}/_matrix/client/v3/login`,
		),
	).rejects.toThrow("destination refused");
	const allowed = matrixFetchFor(origin, { homeserver: origin });
	await expect(allowed("http://other.example:9527/_matrix/client/v3/login")).rejects.toThrow(
		"destination refused",
	);
	await expect(allowed(`${origin}/admin`)).rejects.toThrow("destination refused");
	await expect(allowed(`${origin}/_matrix/client/v3/sync?access_token=secret`)).rejects.toThrow(
		"destination refused",
	);
});
