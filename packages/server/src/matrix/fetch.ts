import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isPublicMatrixAddress } from "./network";

export function matrixFetchFor(allowedOrigin: string, safeHomeserverTest = false) {
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		if (
			url.protocol !== "https:" ||
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
			addresses.some((row) => !safeHomeserverTest && !isPublicMatrixAddress(row.address))
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
			const req = request(
				url,
				{
					method: init?.method ?? "GET",
					headers,
					signal: init?.signal ?? AbortSignal.timeout(45000),
					lookup(_hostname, _options, callback) {
						callback(null, address.address, address.family);
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
