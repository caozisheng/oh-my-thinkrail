import type {
	ForkUpdateBridge,
	ForkUpdateState,
	HostUpdateNotice,
	NativeUpdateBridge,
	NativeUpdateFailedPhase,
	NativeUpdateState,
} from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { useEffect, useState } from "react";
import { useAppStore } from "../store";

const NATIVE_UPDATES_GLOBAL = "__THINKRAIL_NATIVE_UPDATES__";
const FORK_UPDATES_GLOBAL = "__THINKRAIL_FORK_UPDATES__";

export type NativeUpdateAction = Exclude<NativeUpdateFailedPhase, null>;

export interface NativeUpdateRequestError {
	action: NativeUpdateAction;
	message: string;
}

export type UpdatesController =
	| {
			source: "native";
			state: NativeUpdateState;
			requestError: NativeUpdateRequestError | null;
			checkForUpdates(): void;
			downloadUpdate(): void;
			restartToUpdate(): void;
			dismissInstallResult(): void;
	  }
	| {
			source: "fork";
			state: ForkUpdateState;
			checkNow(): void;
			openReleases(): void;
	  }
	| {
			source: "host";
			state: HostUpdateNotice;
			canRun: boolean;
			requestFailed: boolean;
			runUpdate(): void;
	  };

function isBridge(value: unknown, methods: readonly string[]): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		return methods.every((method) => typeof Reflect.get(value, method) === "function");
	} catch {
		return false;
	}
}

export function getNativeUpdateBridge(value: unknown): NativeUpdateBridge | null {
	return isBridge(value, [
		"getState",
		"checkForUpdates",
		"downloadUpdate",
		"restartToUpdate",
		"dismissInstallResult",
		"subscribe",
	])
		? (value as NativeUpdateBridge)
		: null;
}

export function getForkUpdateBridge(value: unknown): ForkUpdateBridge | null {
	return isBridge(value, ["getState", "checkNow", "openReleases", "subscribe"])
		? (value as ForkUpdateBridge)
		: null;
}

function nativeUpdateErrorText(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	if (typeof error === "string" && error.trim()) return error;
	return t("updates.nativeRequestFailed");
}

export function runNativeUpdateRequest(
	action: NativeUpdateAction,
	operation: () => Promise<void>,
	onError: (error: NativeUpdateRequestError) => void,
): void {
	const reject = (error: unknown): void => {
		onError({ action, message: nativeUpdateErrorText(error) });
	};
	try {
		void operation().catch(reject);
	} catch (error) {
		reject(error);
	}
}

export type HostUpdateRunner = () => Promise<unknown>;

export function runHostUpdateRequest(operation: HostUpdateRunner, onError: () => void): void {
	try {
		void operation().catch(() => onError());
	} catch {
		onError();
	}
}

/** Subscribes before the initial read, then accepts only strictly newer revisions from either side. */
function subscribeToRevisionedState<T extends { revision: number }>(
	bridge: {
		getState(): Promise<T>;
		subscribe(listener: (state: T) => void): () => void;
	},
	onState: (state: T) => void,
	onError: (error: unknown) => void,
): () => void {
	let active = true;
	let revision = -1;
	const accept = (state: T): void => {
		if (!active || state.revision <= revision) return;
		revision = state.revision;
		onState(state);
	};
	const reject = (error: unknown): void => {
		if (active) onError(error);
	};
	let unsubscribe: (() => void) | undefined;
	try {
		unsubscribe = bridge.subscribe(accept);
	} catch (error) {
		reject(error);
	}
	try {
		void bridge.getState().then(accept, reject);
	} catch (error) {
		reject(error);
	}
	return () => {
		active = false;
		unsubscribe?.();
	};
}

export function subscribeToNativeUpdates(
	bridge: NativeUpdateBridge,
	onState: (state: NativeUpdateState) => void,
	onError: (error: string) => void,
): () => void {
	return subscribeToRevisionedState(bridge, onState, (error) =>
		onError(nativeUpdateErrorText(error)),
	);
}

/** The fork advisory is silent about failures; only its state matters. */
export function subscribeToForkUpdates(
	bridge: ForkUpdateBridge,
	onState: (state: ForkUpdateState) => void,
): () => void {
	return subscribeToRevisionedState(bridge, onState, () => {});
}

/**
 * Native update authority wins over the fork advisory, which wins over the host's CLI update lifecycle.
 * A present bridge claims the slot: a disabled native surface hands it to the fork only, and never to the
 * host, so an app that owns one of them cannot also show another launcher's lifecycle.
 */
export function selectUpdateSource(input: {
	nativeBridge: NativeUpdateBridge | null;
	nativeState: NativeUpdateState | null;
	forkBridge: ForkUpdateBridge | null;
	forkState: ForkUpdateState | null;
	hostUpdate: HostUpdateNotice | null;
}): "native" | "fork" | "host" | null {
	if (input.nativeBridge) {
		if (!input.nativeState) return null;
		if (input.nativeState.status !== "disabled") return "native";
		if (!input.forkBridge) return null;
	}
	if (input.forkBridge) {
		const fork = input.forkState;
		return fork !== null && fork.status !== "disabled" ? "fork" : null;
	}
	return input.hostUpdate === null ? null : "host";
}

export function useUpdates(hostUpdateRunner: HostUpdateRunner | null): UpdatesController | null {
	const [bridge] = useState(() =>
		getNativeUpdateBridge(Reflect.get(globalThis, NATIVE_UPDATES_GLOBAL)),
	);
	const [forkBridge] = useState(() =>
		getForkUpdateBridge(Reflect.get(globalThis, FORK_UPDATES_GLOBAL)),
	);
	const [nativeState, setNativeState] = useState<NativeUpdateState | null>(null);
	const [nativeRequestError, setNativeRequestError] = useState<NativeUpdateRequestError | null>(
		null,
	);
	const [forkState, setForkState] = useState<ForkUpdateState | null>(null);
	const [failedHostRequestFor, setFailedHostRequestFor] = useState<HostUpdateNotice | null>(null);
	const hostUpdate = useAppStore((state) => state.hostUpdate);

	useEffect(() => {
		if (!bridge) return;
		return subscribeToNativeUpdates(
			bridge,
			(next) => {
				setNativeState(next);
				setNativeRequestError(null);
			},
			() => {},
		);
	}, [bridge]);

	useEffect(() => {
		if (!forkBridge) return;
		return subscribeToForkUpdates(forkBridge, setForkState);
	}, [forkBridge]);

	const source = selectUpdateSource({
		nativeBridge: bridge,
		nativeState,
		forkBridge,
		forkState,
		hostUpdate,
	});
	if (source === "native" && bridge && nativeState) {
		const request = (action: NativeUpdateAction, operation: () => Promise<void>): void => {
			setNativeRequestError(null);
			runNativeUpdateRequest(action, operation, setNativeRequestError);
		};
		return {
			source,
			state: nativeState,
			requestError: nativeRequestError,
			checkForUpdates: () => request("check", () => bridge.checkForUpdates()),
			downloadUpdate: () => request("download", () => bridge.downloadUpdate()),
			restartToUpdate: () => request("install", () => bridge.restartToUpdate()),
			dismissInstallResult: () => {
				void bridge.dismissInstallResult().catch(() => {});
			},
		};
	}
	if (source === "fork" && forkBridge && forkState) {
		return {
			source,
			state: forkState,
			checkNow: () => {
				void forkBridge.checkNow().catch(() => {});
			},
			openReleases: () => {
				void forkBridge.openReleases().catch(() => {});
			},
		};
	}
	if (source === "host" && hostUpdate) {
		const canRun = hostUpdateRunner !== null && hostUpdate.status !== undefined;
		return {
			source,
			state: hostUpdate,
			canRun,
			requestFailed: failedHostRequestFor === hostUpdate,
			runUpdate: () => {
				if (!canRun || !hostUpdateRunner) return;
				setFailedHostRequestFor(null);
				runHostUpdateRequest(hostUpdateRunner, () => setFailedHostRequestFor(hostUpdate));
			},
		};
	}
	return null;
}
