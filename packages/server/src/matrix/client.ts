import { createClient, type MatrixClient } from "matrix-js-sdk";

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

export interface MatrixIdentity {
	readonly userId: string;
	readonly deviceId?: string;
}

export interface MatrixClientOptions {
	readonly baseUrl: string;
	readonly userId?: string;
	readonly accessToken?: string;
	readonly fetchFn?: typeof globalThis.fetch;
	readonly logger?: typeof quietLogger;
}

export function createMatrixClient(options: MatrixClientOptions): MatrixClient {
	return createClient({
		baseUrl: options.baseUrl,
		...(options.userId ? { userId: options.userId } : {}),
		...(options.accessToken ? { accessToken: options.accessToken } : {}),
		fetchFn: options.fetchFn ?? globalThis.fetch,
		logger: options.logger ?? quietLogger,
	});
}

export async function verifyMatrixAccessToken(
	options: MatrixClientOptions & { readonly accessToken: string },
): Promise<MatrixIdentity> {
	const baseUrl = new URL(options.baseUrl);
	if (
		baseUrl.protocol !== "https:" ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash ||
		baseUrl.pathname !== "/" ||
		options.accessToken.trim() !== options.accessToken ||
		options.accessToken.length > 4096 ||
		!options.accessToken
	) {
		throw new Error("Invalid Matrix homeserver URL");
	}

	const client = createMatrixClient({ ...options, baseUrl: baseUrl.origin, logger: quietLogger });
	try {
		const identity = await client.whoami();
		if (typeof identity.user_id !== "string" || !/^@[^:\s]+:[^:\s]+$/.test(identity.user_id)) {
			throw new Error("Invalid Matrix identity");
		}
		if (options.userId && identity.user_id !== options.userId) {
			throw new Error("Matrix identity mismatch");
		}
		return {
			userId: identity.user_id,
			...(typeof identity.device_id === "string" ? { deviceId: identity.device_id } : {}),
		};
	} finally {
		client.stopClient();
	}
}
