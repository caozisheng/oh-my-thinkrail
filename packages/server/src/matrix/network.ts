import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function ipv4Number(address: string): number | null {
	if (isIP(address) !== 4) return null;
	return address.split(".").reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
}

function inV4Range(address: string, base: string, bits: number): boolean {
	const value = ipv4Number(address);
	const start = ipv4Number(base);
	if (value === null || start === null) return false;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) === (start & mask);
}

function ipv6Groups(input: string): number[] | null {
	if (isIP(input) !== 6 || input.includes("%")) return null;
	let value = input.toLowerCase();
	if (value.includes(".")) {
		const colon = value.lastIndexOf(":");
		const v4 = ipv4Number(value.slice(colon + 1));
		if (v4 === null) return null;
		value = `${value.slice(0, colon)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
	const right = halves[1] ? halves[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
	const zeros = 8 - left.length - right.length;
	if (zeros < (halves.length === 1 ? 0 : 1)) return null;
	return [...left, ...Array(zeros).fill(0), ...right];
}

function inV6(address: string, prefix: readonly number[], bits: number): boolean {
	const groups = ipv6Groups(address);
	if (!groups) return false;
	for (let bit = 0; bit < bits; bit++) {
		const index = bit >> 4;
		const shift = 15 - (bit & 15);
		if ((((groups[index] ?? 0) >> shift) & 1) !== (((prefix[index] ?? 0) >> shift) & 1))
			return false;
	}
	return true;
}

export function isPublicMatrixAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const blocked: [string, number][] = [
			["0.0.0.0", 8],
			["10.0.0.0", 8],
			["100.64.0.0", 10],
			["127.0.0.0", 8],
			["169.254.0.0", 16],
			["172.16.0.0", 12],
			["192.0.0.0", 24],
			["192.0.2.0", 24],
			["192.88.99.0", 24],
			["192.168.0.0", 16],
			["198.18.0.0", 15],
			["198.51.100.0", 24],
			["203.0.113.0", 24],
			["224.0.0.0", 4],
			["240.0.0.0", 4],
		];
		return !blocked.some(([base, bits]) => inV4Range(address, base, bits));
	}
	if (isIP(address) === 6) {
		const blocked: [number[], number][] = [
			[[0, 0, 0, 0, 0, 0, 0, 0], 128],
			[[0, 0, 0, 0, 0, 0, 0, 1], 128],
			[[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7],
			[[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10],
			[[0xff00, 0, 0, 0, 0, 0, 0, 0], 8],
			[[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32],
		];
		if (inV6(address, [0, 0, 0, 0, 0, 0xffff, 0, 0], 96)) {
			const groups = ipv6Groups(address);
			if (!groups) return false;
			const high = groups[6] ?? 0;
			const low = groups[7] ?? 0;
			const mapped = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
			return isPublicMatrixAddress(mapped);
		}
		return !blocked.some(([prefix, bits]) => inV6(address, prefix, bits));
	}
	return false;
}

export function isPrivateMatrixAddress(address: string): boolean {
	if (isIP(address) === 4)
		return (
			inV4Range(address, "10.0.0.0", 8) ||
			inV4Range(address, "172.16.0.0", 12) ||
			inV4Range(address, "192.168.0.0", 16) ||
			inV4Range(address, "100.64.0.0", 10)
		);
	if (isIP(address) !== 6) return false;
	if (inV6(address, [0, 0, 0, 0, 0, 0xffff, 0, 0], 96)) {
		const groups = ipv6Groups(address);
		if (!groups) return false;
		const high = groups[6] ?? 0;
		const low = groups[7] ?? 0;
		return isPrivateMatrixAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
	}
	return inV6(address, [0xfc00, 0, 0, 0, 0, 0, 0, 0], 7);
}

export async function assertSafeHomeserver(value: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid Matrix homeserver.");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("Invalid Matrix homeserver.");
	if (
		url.hostname === "localhost" ||
		url.hostname.endsWith(".localhost") ||
		url.hostname.endsWith(".local")
	)
		throw new Error("Matrix homeserver address is not supported.");
	const records = await lookup(url.hostname, { all: true, verbatim: true });
	if (
		!records.length ||
		records.some(
			(record) => !isPublicMatrixAddress(record.address) && !isPrivateMatrixAddress(record.address),
		)
	)
		throw new Error("Matrix homeserver address is not supported.");
	return new URL(url.origin);
}
