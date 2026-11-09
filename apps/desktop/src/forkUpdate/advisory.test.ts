import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForkUpdateAdvisoryStore, shouldNotify } from "./advisory";
import { forkUpdatesEnabled } from "./enablement";

function temporaryDirectory(): string {
	return mkdtempSync(join(tmpdir(), "thinkrail-fork-update-"));
}

test("notifies once per discovered version and only while unfocused", () => {
	const base = { availableVersion: "0.3.0.1a2b3c4d", lastNotifiedVersion: null };
	expect(shouldNotify({ ...base, windowFocused: false })).toBe(true);
	expect(shouldNotify({ ...base, windowFocused: true })).toBe(false);
	expect(
		shouldNotify({
			...base,
			windowFocused: false,
			lastNotifiedVersion: "0.3.0.1a2b3c4d",
		}),
	).toBe(false);
	expect(
		shouldNotify({
			...base,
			windowFocused: false,
			availableVersion: "0.3.1.ffffffff",
			lastNotifiedVersion: "0.3.0.1a2b3c4d",
		}),
	).toBe(true);
	expect(shouldNotify({ ...base, windowFocused: false, availableVersion: null })).toBe(false);
});

test("remembers the last notified version across reads", () => {
	const directory = temporaryDirectory();
	try {
		const path = join(directory, "fork-update-advisory.json");
		const errors: unknown[] = [];
		const store = createForkUpdateAdvisoryStore(path, (error) => errors.push(error));
		expect(store.readLastNotifiedVersion()).toBeNull();
		store.writeLastNotifiedVersion("0.3.0.1a2b3c4d");
		expect(store.readLastNotifiedVersion()).toBe("0.3.0.1a2b3c4d");
		expect(errors).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			schemaVersion: 1,
			lastNotifiedVersion: "0.3.0.1a2b3c4d",
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an unreadable or malformed advisory file forgets the version", () => {
	const directory = temporaryDirectory();
	try {
		const path = join(directory, "fork-update-advisory.json");
		const store = createForkUpdateAdvisoryStore(path, () => {});
		writeFileSync(path, "{not json");
		expect(store.readLastNotifiedVersion()).toBeNull();
		writeFileSync(path, JSON.stringify({ lastNotifiedVersion: "0.3" }));
		expect(store.readLastNotifiedVersion()).toBeNull();
		writeFileSync(path, JSON.stringify({ lastNotifiedVersion: "0.3.0.1A2B3C4D" }));
		expect(store.readLastNotifiedVersion()).toBeNull();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("enables only the packaged stable Windows x64 build outside artifact seams", () => {
	const enabled = {
		isPackaged: true,
		channel: "stable",
		platform: "win32" as const,
		arch: "x64",
		artifactTestSeam: false,
	};
	expect(forkUpdatesEnabled(enabled)).toBe(true);
	expect(forkUpdatesEnabled({ ...enabled, isPackaged: false })).toBe(false);
	expect(forkUpdatesEnabled({ ...enabled, artifactTestSeam: true })).toBe(false);
	expect(forkUpdatesEnabled({ ...enabled, channel: "canary" })).toBe(false);
	expect(forkUpdatesEnabled({ ...enabled, channel: "dev" })).toBe(false);
	expect(forkUpdatesEnabled({ ...enabled, platform: "darwin" })).toBe(false);
	expect(forkUpdatesEnabled({ ...enabled, arch: "arm64" })).toBe(false);
});
