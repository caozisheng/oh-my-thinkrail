import { describe, expect, test } from "bun:test";
import type {
	ForkUpdateBridge,
	ForkUpdateState,
	HostUpdateNotice,
	NativeUpdateBridge,
	NativeUpdateState,
} from "@thinkrail/contracts";
import {
	getForkUpdateBridge,
	getNativeUpdateBridge,
	runHostUpdateRequest,
	runNativeUpdateRequest,
	selectUpdateSource,
	subscribeToForkUpdates,
	subscribeToNativeUpdates,
} from "./useUpdates";

function nativeState(revision: number, status: NativeUpdateState["status"]): NativeUpdateState {
	return {
		revision,
		status,
		version: "0.1.0",
		channel: "canary",
		availableVersion:
			status === "available" ||
			status === "downloading" ||
			status === "preparing" ||
			status === "ready"
				? "0.1.1"
				: null,
		progress: null,
		error: null,
		failedPhase: null,
		installStep: null,
		log: [],
		lastInstall: null,
	};
}

function hostNotice(): HostUpdateNotice {
	return {
		currentVersion: "0.1.0",
		channel: "stable",
		availableVersion: "0.2.0",
	};
}

function forkState(revision: number, status: ForkUpdateState["status"]): ForkUpdateState {
	return {
		revision,
		status,
		version: "0.3.0.aaaaaaaa",
		availableVersion: status === "available" ? "0.3.1.bbbbbbbb" : null,
	};
}

function forkBridge(): ForkUpdateBridge {
	return {
		getState: async () => forkState(1, "idle"),
		checkNow: async () => {},
		openReleases: async () => {},
		subscribe: () => () => {},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function nativeBridge(state = nativeState(1, "idle")): NativeUpdateBridge {
	return {
		getState: async () => state,
		checkForUpdates: async () => {},
		downloadUpdate: async () => {},
		restartToUpdate: async () => {},
		dismissInstallResult: async () => {},
		subscribe: () => () => {},
	};
}

describe("native update shell subscription", () => {
	test("subscribes before reading and keeps a newer push over the initial read", async () => {
		const initial = deferred<NativeUpdateState>();
		const order: string[] = [];
		const observed: NativeUpdateState[] = [];
		let push: ((next: NativeUpdateState) => void) | undefined;
		const bridge: NativeUpdateBridge = {
			getState: () => {
				order.push("get");
				return initial.promise;
			},
			checkForUpdates: async () => {},
			downloadUpdate: async () => {},
			restartToUpdate: async () => {},
			dismissInstallResult: async () => {},
			subscribe: (listener) => {
				order.push("subscribe");
				push = listener;
				return () => {};
			},
		};

		const unsubscribe = subscribeToNativeUpdates(
			bridge,
			(next) => observed.push(next),
			() => {},
		);
		expect(order).toEqual(["subscribe", "get"]);
		push?.(nativeState(2, "ready"));
		initial.resolve(nativeState(1, "idle"));
		await initial.promise;
		await Promise.resolve();
		expect(observed).toEqual([nativeState(2, "ready")]);
		unsubscribe();
	});

	test("request errors carry the failed native action", async () => {
		const errors: Array<{ action: string; message: string }> = [];
		runNativeUpdateRequest(
			"download",
			async () => {
				throw new Error("Update RPC timed out");
			},
			(error) => errors.push(error),
		);
		await Promise.resolve();
		expect(errors).toEqual([{ action: "download", message: "Update RPC timed out" }]);
	});

	test("host request failures collapse without exposing the transport diagnostic", async () => {
		let failures = 0;
		runHostUpdateRequest(
			async () => {
				throw new Error("private server diagnostic");
			},
			() => failures++,
		);
		await Promise.resolve();
		expect(failures).toBe(1);
	});

	test("bridge validation requires the complete download-capable surface", () => {
		expect(getNativeUpdateBridge(undefined)).toBeNull();
		expect(getNativeUpdateBridge({ getState() {} })).toBeNull();
		expect(
			getNativeUpdateBridge({
				getState: async () => nativeState(1, "idle"),
				checkForUpdates: async () => {},
				restartToUpdate: async () => {},
				subscribe: () => () => {},
			}),
		).toBeNull();
		expect(getNativeUpdateBridge(nativeBridge())).not.toBeNull();
	});

	test("fork bridge validation requires the advisory surface", () => {
		expect(getForkUpdateBridge(undefined)).toBeNull();
		expect(getForkUpdateBridge({ getState: async () => forkState(1, "idle") })).toBeNull();
		expect(getForkUpdateBridge(forkBridge())).not.toBeNull();
	});

	test("fork subscription keeps a newer push over the initial read and ignores failures", async () => {
		const initial = deferred<ForkUpdateState>();
		const observed: ForkUpdateState[] = [];
		let push: ((next: ForkUpdateState) => void) | undefined;
		const unsubscribe = subscribeToForkUpdates(
			{
				getState: () => initial.promise,
				checkNow: async () => {},
				openReleases: async () => {},
				subscribe: (listener) => {
					push = listener;
					return () => {};
				},
			},
			(next) => observed.push(next),
		);
		push?.(forkState(2, "available"));
		initial.resolve(forkState(1, "idle"));
		await initial.promise;
		await Promise.resolve();
		expect(observed).toEqual([forkState(2, "available")]);
		unsubscribe();
	});
});

describe("unified update capability", () => {
	test("native authority wins while resolving and when enabled instead of falling through", () => {
		const bridge = nativeBridge();
		expect(
			selectUpdateSource({
				nativeBridge: bridge,
				nativeState: nativeState(1, "idle"),
				forkBridge: forkBridge(),
				forkState: forkState(1, "available"),
				hostUpdate: hostNotice(),
			}),
		).toBe("native");
		expect(
			selectUpdateSource({
				nativeBridge: bridge,
				nativeState: null,
				forkBridge: forkBridge(),
				forkState: forkState(1, "available"),
				hostUpdate: hostNotice(),
			}),
		).toBeNull();
	});

	test("a disabled native surface hands the slot to the fork advisory, never to the host", () => {
		expect(
			selectUpdateSource({
				nativeBridge: nativeBridge(),
				nativeState: nativeState(1, "disabled"),
				forkBridge: forkBridge(),
				forkState: forkState(1, "available"),
				hostUpdate: hostNotice(),
			}),
		).toBe("fork");
		expect(
			selectUpdateSource({
				nativeBridge: nativeBridge(),
				nativeState: nativeState(1, "disabled"),
				forkBridge: null,
				forkState: null,
				hostUpdate: hostNotice(),
			}),
		).toBeNull();
	});

	test("a fork capability that is resolving or disabled shows nothing", () => {
		const sources = {
			nativeBridge: null,
			forkBridge: forkBridge(),
			hostUpdate: hostNotice(),
		};
		expect(selectUpdateSource({ ...sources, nativeState: null, forkState: null })).toBeNull();
		expect(
			selectUpdateSource({ ...sources, nativeState: null, forkState: forkState(1, "disabled") }),
		).toBeNull();
		expect(
			selectUpdateSource({ ...sources, nativeState: null, forkState: forkState(1, "idle") }),
		).toBe("fork");
	});

	test("host authority exists exactly when no bridge and a host snapshot is present", () => {
		expect(
			selectUpdateSource({
				nativeBridge: null,
				nativeState: null,
				forkBridge: null,
				forkState: null,
				hostUpdate: hostNotice(),
			}),
		).toBe("host");
		expect(
			selectUpdateSource({
				nativeBridge: null,
				nativeState: null,
				forkBridge: null,
				forkState: null,
				hostUpdate: null,
			}),
		).toBeNull();
	});
});
