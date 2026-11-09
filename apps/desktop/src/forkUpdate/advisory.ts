import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FORK_UPDATE_ADVISORY_FILE = "fork-update-advisory.json";

const MAX_ADVISORY_BYTES = 4096;
const ADVISED_VERSION_PATTERN = /^\d+\.\d+\.\d+\.[0-9a-f]{8}$/;

export interface ForkUpdateAdvisoryStore {
	readLastNotifiedVersion(): string | null;
	writeLastNotifiedVersion(version: string): void;
}

/**
 * One notification per discovered version, and only while the window is unfocused: a focused window
 * already shows the Settings card and the topbar chip.
 */
export function shouldNotify(input: {
	availableVersion: string | null;
	windowFocused: boolean;
	lastNotifiedVersion: string | null;
}): boolean {
	if (input.availableVersion === null || input.windowFocused) return false;
	return input.availableVersion !== input.lastNotifiedVersion;
}

/** The once-per-version notification memory; an unreadable file simply forgets. */
export function createForkUpdateAdvisoryStore(
	path: string,
	reportError: (error: unknown) => void,
): ForkUpdateAdvisoryStore {
	return {
		readLastNotifiedVersion: () => {
			try {
				const stat = statSync(path, { throwIfNoEntry: false });
				if (!stat?.isFile() || stat.size > MAX_ADVISORY_BYTES) return null;
				const document: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (typeof document !== "object" || document === null) return null;
				const version: unknown = Reflect.get(document, "lastNotifiedVersion");
				return typeof version === "string" && ADVISED_VERSION_PATTERN.test(version)
					? version
					: null;
			} catch (error) {
				reportError(error);
				return null;
			}
		},
		writeLastNotifiedVersion: (version) => {
			const partial = `${path}.partial`;
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(partial, JSON.stringify({ schemaVersion: 1, lastNotifiedVersion: version }));
				renameSync(partial, path);
			} catch (error) {
				reportError(error);
				try {
					rmSync(partial, { force: true });
				} catch {
					// The write itself already failed; a leftover partial file is only debris.
				}
			}
		},
	};
}
