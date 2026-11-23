export type { MatrixClientOptions, MatrixIdentity } from "./client";
export { createMatrixClient, verifyMatrixAccessToken } from "./client";
export { matrixFetchFor } from "./fetch";
export type {
	MatrixHostPort,
	MatrixProjectionState,
	MatrixProjectionStore,
	MatrixSessionTarget,
} from "./projection";
export { emptyProjection } from "./projection";
export type {
	MatrixCredentialStore,
	MatrixPersistence,
	MatrixRecord,
	MatrixService,
} from "./service";
export { createMatrixService } from "./service";
