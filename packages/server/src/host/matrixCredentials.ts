import { createHash } from "node:crypto";
import { CodedError } from "@thinkrail/shared/codedError";
import type { MatrixCredentialStore } from "../matrix/service";

type MatrixSecretsBackend = Pick<typeof Bun.secrets, "get" | "set" | "delete">;
const SERVICE = "ThinkRailMatrix";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function unavailable(): never {
	throw new CodedError("RESOURCE_UNAVAILABLE", "Matrix credentials are unavailable.");
}

export function createMatrixCredentials(options: {
	namespace: string;
	secrets?: MatrixSecretsBackend;
	platform?: NodeJS.Platform;
}): MatrixCredentialStore {
	const getBackend = () => options.secrets ?? Bun.secrets;
	const account = (id: string) => {
		if (!options.namespace.trim() || options.namespace.length > 4096 || !uuid.test(id))
			unavailable();
		const name = createHash("sha256")
			.update(JSON.stringify([options.namespace, id]))
			.digest("hex");
		return { service: SERVICE, name: `v1-${name}` };
	};
	return {
		async get(id) {
			try {
				const value = await getBackend().get(account(id));
				if (value !== null && (!value || value.length > 4096 || !/^[\x20-\x7e]+$/.test(value)))
					unavailable();
				return value;
			} catch {
				return unavailable();
			}
		},
		async set(id, value) {
			try {
				if (!value || value.length > 4096 || !/^[\x20-\x7e]+$/.test(value)) unavailable();
				const result = await getBackend().set({
					...account(id),
					value,
					...((options.platform ?? process.platform) === "win32"
						? { persist: "local" as const }
						: {}),
				});
				if (result !== undefined) unavailable();
			} catch {
				unavailable();
			}
		},
		async delete(id) {
			try {
				const result = await getBackend().delete(account(id));
				if (typeof result !== "boolean") unavailable();
			} catch {
				unavailable();
			}
		},
	};
}
