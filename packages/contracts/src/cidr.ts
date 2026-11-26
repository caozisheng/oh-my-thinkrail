export function isValidCidrRange(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
	const parts = value.split("/");
	if (parts.length !== 2 || !/^\d+$/.test(parts[1] ?? "")) return false;
	const [address, prefixText] = parts;
	const prefix = Number(prefixText);
	if (!Number.isInteger(prefix)) return false;

	const octets = address?.split(".");
	if (
		octets?.length === 4 &&
		octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
	) {
		return prefix > 0 && prefix <= 32;
	}

	if (prefix <= 0 || prefix > 128 || !address || address.includes("%")) return false;
	try {
		new URL(`http://[${address}]/`);
		return true;
	} catch {
		return false;
	}
}
