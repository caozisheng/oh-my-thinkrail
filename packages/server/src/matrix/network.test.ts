import { expect, test } from "bun:test";
import { isPublicMatrixAddress } from "./network";

test("rejects private, loopback, metadata, mapped IPv6 and reserved egress addresses", () => {
	for (const ip of [
		"127.0.0.1",
		"10.1.2.3",
		"169.254.169.254",
		"192.168.1.1",
		"172.16.0.1",
		"0.0.0.0",
		"100.64.1.1",
		"::1",
		"::",
		"fd00::1",
		"fe80::1",
		"::ffff:127.0.0.1",
		"224.0.0.1",
		"2001:db8::1",
	])
		expect(isPublicMatrixAddress(ip)).toBe(false);
	for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
		expect(isPublicMatrixAddress(ip)).toBe(true);
});
