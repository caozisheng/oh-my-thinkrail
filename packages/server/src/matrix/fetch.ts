import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isPrivateMatrixAddress, isPublicMatrixAddress } from "./network";

export function pinnedMatrixLookupResult(
	address: { address: string; family: number },
	options: unknown,
): unknown[] {
	return options && typeof options === "object" && "all" in options && options.all
		? [null, [address]]
		: [null, address.address, address.family];
}

export function matrixFetchFor(allowedOrigin: string, consent?: { homeserver: string }) {
	const authorized = consent?.homeserver === allowedOrigin;
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		if (
			(url.protocol !== "https:" && !(authorized && url.protocol === "http:")) ||
			url.username ||
			url.password ||
			!url.pathname.startsWith("/_matrix/") ||
			url.searchParams.has("access_token")
		)
			throw new Error("Matrix destination refused");
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		if (url.origin !== allowedOrigin || !url.pathname.startsWith("/_matrix/"))
			throw new Error("Matrix destination refused");
		const addresses = await lookup(hostname, { all: true, verbatim: true });
		if (
			!addresses.length ||
			addresses.some(
				(row) =>
					!isPublicMatrixAddress(row.address) &&
					!(authorized && isPrivateMatrixAddress(row.address)),
			)
		)
			throw new Error("Matrix destination refused");
		const address = addresses[0];
		if (!address) throw new Error("Matrix destination refused");
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const body = init?.body;
		if (body !== undefined && body !== null && typeof body !== "string")
			throw new Error("Matrix body unsupported");
		if (typeof body === "string" && Buffer.byteLength(body) > 2 * 1024 * 1024)
			throw new Error("Matrix request too large");
		return new Promise<Response>((resolve, reject) => {
			const req = (url.protocol === "http:" ? httpRequest : httpsRequest)(
				url,
				{
					method: init?.method ?? "GET",
					headers,
					signal: init?.signal ?? AbortSignal.timeout(45000),
					lookup(_hostname, options, callback) {
						Reflect.apply(callback, undefined, pinnedMatrixLookupResult(address, options));
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > 8 * 1024 * 1024) {
							req.destroy(new Error("Matrix response too large"));
							return;
						}
						chunks.push(chunk);
					});
					res.on("error", () => reject(new Error("Matrix request failed")));
					res.on("end", () => {
						const status = res.statusCode ?? 502;
						if (status >= 300 && status < 400) {
							reject(new Error("Matrix redirect refused"));
							return;
						}
						const responseHeaders = new Headers();
						for (const [name, value] of Object.entries(res.headers))
							if (value) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
						resolve(
							new Response(status === 204 ? null : Buffer.concat(chunks), {
								status,
								headers: responseHeaders,
							}),
						);
					});
				},
			);
			req.setTimeout(45000, () => req.destroy(new Error("Matrix request timed out")));
			req.on("error", () => reject(new Error("Matrix request failed")));
			req.end(body ?? undefined);
		});
	};
	return Object.assign(fetchImpl, { preconnect() {} });
}
