import { expect, test } from "bun:test";
import { isValidCidrRange } from "./cidr";

test("CIDR ranges accept valid IPv4 and IPv6 networks but reject catch-all ranges", () => {
	for (const range of ["10.0.0.0/8", "192.168.1.7/32", "fd00::/8", "2001:db8::1/128"])
		expect(isValidCidrRange(range)).toBe(true);

	for (const range of [
		"",
		"10.0.0.0",
		"10.0.0.0/33",
		"10.0.0.0/-1",
		"10.0.0.0/8/2",
		"010.0.0.1/8",
		"2001:db8::/129",
		"0.0.0.0/0",
		"::/0",
		"fe80::1%eth0/64",
	]) {
		expect(isValidCidrRange(range)).toBe(false);
	}
});

test("CIDR syntax does not silently trim input", () => {
	expect(isValidCidrRange("10.0.0.0/8")).toBe(true);
	expect(isValidCidrRange("10.0.0.0/8 ")).toBe(false);
});
