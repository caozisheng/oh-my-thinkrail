import type { ForkUpdateBridge, ForkUpdateState, ForkUpdateStatus } from "@thinkrail/contracts";
import { desktopError } from "../errorReporting";
import { type ForkUpdateAdvisoryStore, shouldNotify } from "./advisory";
import { compareForkVersion, type ForkRelease, forkReleaseUrl } from "./release";

const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_CHECK_JITTER_RATIO = 0.1;

type CancelSchedule = () => void;

export interface ForkUpdateControllerDependencies {
	enabled: boolean;
	version: string;
	latestRelease(): Promise<ForkRelease | null>;
	notify(version: string): void;
	openExternal(url: string): void;
	windowFocused?(): boolean;
	advisory?: ForkUpdateAdvisoryStore;
	schedule?(delayMs: number, callback: () => void): CancelSchedule;
	random?(): number;
}

export interface ForkUpdateController extends ForkUpdateBridge {
	start(): void;
	dispose(): void;
}

function defaultSchedule(delayMs: number, callback: () => void): CancelSchedule {
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
}

export function createForkUpdateController(
	dependencies: ForkUpdateControllerDependencies,
): ForkUpdateController {
	const schedule = dependencies.schedule ?? defaultSchedule;
	const random = dependencies.random ?? Math.random;
	const listeners = new Set<(state: ForkUpdateState) => void>();
	let state: Readonly<ForkUpdateState> = Object.freeze({
		revision: 0,
		status: dependencies.enabled ? "idle" : "disabled",
		version: dependencies.version,
		availableVersion: null,
	});
	let cancelScheduled: CancelSchedule | undefined;
	let checking = false;
	let started = false;
	let disposed = false;

	const publish = (patch: Partial<Pick<ForkUpdateState, "status" | "availableVersion">>): void => {
		if (disposed) return;
		const next = { ...state, ...patch };
		if (next.status === state.status && next.availableVersion === state.availableVersion) return;
		state = Object.freeze({ ...next, revision: state.revision + 1 });
		for (const listener of listeners) {
			try {
				listener(state);
			} catch (error) {
				desktopError("forkUpdate", "fork update listener failed", error);
			}
		}
	};

	const setStatus = (status: ForkUpdateStatus): void => {
		publish({ status });
	};

	const notifyIfDue = (version: string): void => {
		const advisory = dependencies.advisory;
		const lastNotifiedVersion = advisory?.readLastNotifiedVersion() ?? null;
		if (
			!shouldNotify({
				availableVersion: version,
				windowFocused: dependencies.windowFocused?.() ?? true,
				lastNotifiedVersion,
			})
		) {
			return;
		}
		advisory?.writeLastNotifiedVersion(version);
		try {
			dependencies.notify(version);
		} catch (error) {
			desktopError("forkUpdate", "fork update notification failed", error);
		}
	};

	const accept = (release: ForkRelease | null): void => {
		if (release && compareForkVersion(state.version, release) === "newer") {
			publish({ status: "available", availableVersion: release.version });
			notifyIfDue(release.version);
			return;
		}
		setStatus(state.availableVersion === null ? "idle" : "available");
	};

	const scheduleNextCheck = (): void => {
		if (!started || disposed) return;
		cancelScheduled?.();
		const unit = Math.min(1, Math.max(0, random()));
		const jitter = (unit * 2 - 1) * AUTO_CHECK_INTERVAL_MS * AUTO_CHECK_JITTER_RATIO;
		cancelScheduled = schedule(Math.round(AUTO_CHECK_INTERVAL_MS + jitter), () => {
			cancelScheduled = undefined;
			void runCheck();
		});
	};

	const runCheck = async (): Promise<void> => {
		if (!dependencies.enabled || disposed || checking) return;
		checking = true;
		setStatus("checking");
		try {
			const release = await dependencies.latestRelease();
			if (!disposed) accept(release);
		} catch {
			if (!disposed) setStatus(state.availableVersion === null ? "idle" : "available");
		} finally {
			checking = false;
			scheduleNextCheck();
		}
	};

	return {
		getState: async () => ({ ...state }),
		checkNow: async () => {
			if (!dependencies.enabled || disposed) return;
			cancelScheduled?.();
			cancelScheduled = undefined;
			started = true;
			await runCheck();
		},
		openReleases: async () => {
			const version = state.availableVersion;
			if (version === null || disposed) return;
			try {
				dependencies.openExternal(forkReleaseUrl(`v${version}`));
			} catch (error) {
				desktopError("forkUpdate", "could not open the fork releases page", error);
			}
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start: () => {
			if (!dependencies.enabled || started || disposed) return;
			started = true;
			void runCheck();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			cancelScheduled?.();
			cancelScheduled = undefined;
			listeners.clear();
		},
	};
}
