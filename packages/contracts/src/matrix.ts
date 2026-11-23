export type MatrixErrorCode =
	| "invalid-input"
	| "authentication"
	| "identity-mismatch"
	| "network"
	| "credentials"
	| "storage"
	| "busy"
	| "reconciliation-required"
	| "room-encrypted"
	| "sync";

export type MatrixConnectionInput = {
	operationId: string;
	homeserver: string;
	botUserId: string;
	controllerUserId: string;
	plaintextAcknowledged: true;
} & (
	| { mode: "password"; password: string; accessToken?: never }
	| { mode: "access-token"; accessToken: string; password?: never }
);

export interface MatrixStatus {
	phase: "disconnected" | "authenticating" | "connected" | "syncing" | "paused" | "error";
	homeserver?: string;
	botUserId?: string;
	controllerUserId?: string;
	mode?: "password" | "access-token";
	hasCredential: boolean;
	operationId?: string;
	error?: MatrixErrorCode;
	projects: number;
	sessions: number;
	backfilled: number;
	lastSyncedAt?: number;
}

export function canonicalMatrixHomeserver(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 2048 || /[\s\\@?#]/.test(value)) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

export function isMatrixUserId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 255 && /^@[^:\s]+:[^\s/]+$/.test(value);
}

export function isMatrixConnectionInput(value: unknown): value is MatrixConnectionInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	const keys = [
		"operationId",
		"homeserver",
		"botUserId",
		"controllerUserId",
		"plaintextAcknowledged",
		"mode",
		row.mode === "password" ? "password" : "accessToken",
	];
	const secret = row.mode === "password" ? row.password : row.accessToken;
	return (
		Object.keys(row).length === keys.length &&
		keys.every((key) => Object.hasOwn(row, key)) &&
		typeof row.operationId === "string" &&
		/^[a-zA-Z0-9_-]{1,128}$/.test(row.operationId) &&
		canonicalMatrixHomeserver(row.homeserver) !== null &&
		isMatrixUserId(row.botUserId) &&
		isMatrixUserId(row.controllerUserId) &&
		row.botUserId !== row.controllerUserId &&
		row.plaintextAcknowledged === true &&
		(row.mode === "password" || row.mode === "access-token") &&
		typeof secret === "string" &&
		secret.length > 0 &&
		secret.length <= 4096
	);
}
