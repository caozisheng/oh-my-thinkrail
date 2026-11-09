import { expect, test } from "bun:test";
import type { ForkUpdateAdvisoryStore } from "./advisory";
import { createForkUpdateController, type ForkUpdateControllerDependencies } from "./controller";
import type { ForkRelease } from "./release";
import { fetchLatestForkRelease } from "./releaseFetch";

function release(version: string): ForkRelease {
	return { version, tag: `v${version}` };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function memoryAdvisory(initial: string | null = null) {
	const values = { lastNotifiedVersion: initial };
	const store: ForkUpdateAdvisoryStore = {
		readLastNotifiedVersion: () => values.lastNotifiedVersion,
		writeLastNotifiedVersion: (version) => {
			values.lastNotifiedVersion = version;
		},
	};
	return { store, values };
}

function harness(
	options: {
		answer?: ForkRelease | null;
		focused?: boolean;
		notified?: string | null;
		enabled?: boolean;
		version?: string;
	} = {},
) {
	const scheduled: Array<{ delay: number; callback: () => void; cancelled: boolean }> = [];
	const notified: string[] = [];
	const opened: string[] = [];
	const advisory = memoryAdvisory(options.notified ?? null);
	const calls = { latest: 0 };
	const dependencies: ForkUpdateControllerDependencies = {
		enabled: options.enabled ?? true,
		version: options.version ?? "0.2.0.aaaaaaaa",
		latestRelease: async () => {
			calls.latest += 1;
			return options.answer === undefined ? release("0.3.0.bbbbbbbb") : options.answer;
		},
		notify: (version) => notified.push(version),
		openExternal: (url) => opened.push(url),
		windowFocused: () => options.focused ?? false,
		advisory: advisory.store,
		random: () => 0.5,
		schedule: (delay, callback) => {
			const entry = { delay, callback, cancelled: false };
			scheduled.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
	};
	return {
		controller: createForkUpdateController(dependencies),
		scheduled,
		notified,
		opened,
		advisory,
		calls,
	};
}

test("starts disabled outside the enabled gate and never checks", async () => {
	const { controller, calls } = harness({ enabled: false });
	controller.start();
	await settle();
	expect(await controller.getState()).toEqual({
		revision: 0,
		status: "disabled",
		version: "0.2.0.aaaaaaaa",
		availableVersion: null,
	});
	expect(calls.latest).toBe(0);
});

test("reports an available release, notifies once while unfocused and schedules the next check", async () => {
	const { controller, scheduled, notified, advisory } = harness();
	controller.start();
	await settle();
	expect(await controller.getState()).toEqual({
		revision: 2,
		status: "available",
		version: "0.2.0.aaaaaaaa",
		availableVersion: "0.3.0.bbbbbbbb",
	});
	expect(notified).toEqual(["0.3.0.bbbbbbbb"]);
	expect(advisory.values.lastNotifiedVersion).toBe("0.3.0.bbbbbbbb");
	expect(scheduled).toHaveLength(1);
	expect(scheduled[0]?.delay).toBe(6 * 60 * 60 * 1000);
});

test("suppresses the notification while the window has focus", async () => {
	const { controller, notified, advisory } = harness({ focused: true });
	controller.start();
	await settle();
	expect((await controller.getState()).status).toBe("available");
	expect(notified).toEqual([]);
	expect(advisory.values.lastNotifiedVersion).toBeNull();
});

test("does not notify again for a version already announced", async () => {
	const { controller, notified } = harness({ notified: "0.3.0.bbbbbbbb" });
	controller.start();
	await settle();
	expect((await controller.getState()).status).toBe("available");
	expect(notified).toEqual([]);
});

test("stays idle for the running version and for an older release", async () => {
	const same = harness({ answer: release("0.2.0.aaaaaaaa"), notified: "0.3.0.bbbbbbbb" });
	same.controller.start();
	await settle();
	expect((await same.controller.getState()).status).toBe("idle");
	expect(same.notified).toEqual([]);

	const older = harness({ answer: release("0.1.0.ffffffff") });
	older.controller.start();
	await settle();
	expect((await older.controller.getState()).status).toBe("idle");
	expect(older.notified).toEqual([]);
});

test("a matching tag keeps a previously discovered release available", async () => {
	const { controller } = harness();
	controller.start();
	await settle();
	await controller.checkNow();
	await settle();
	const state = await controller.getState();
	expect(state.status).toBe("available");
	expect(state.availableVersion).toBe("0.3.0.bbbbbbbb");
});

test("a failed or unparsable check is silent and keeps the surface idle", async () => {
	const failing = createForkUpdateController({
		enabled: true,
		version: "0.2.0.aaaaaaaa",
		latestRelease: async () => {
			throw new Error("network down");
		},
		notify: () => {},
		openExternal: () => {},
		windowFocused: () => false,
		random: () => 0.5,
		schedule: () => () => {},
	});
	failing.start();
	await settle();
	expect(await failing.getState()).toEqual({
		revision: 2,
		status: "idle",
		version: "0.2.0.aaaaaaaa",
		availableVersion: null,
	});

	const unparsable = harness({ answer: null });
	unparsable.controller.start();
	await settle();
	expect((await unparsable.controller.getState()).status).toBe("idle");
	expect(unparsable.notified).toEqual([]);
});

test("opens the locally composed release page for the available version", async () => {
	const { controller, opened } = harness();
	await controller.openReleases();
	expect(opened).toEqual([]);
	controller.start();
	await settle();
	await controller.openReleases();
	expect(opened).toEqual([
		"https://github.com/caozisheng/oh-my-thinkrail/releases/tag/v0.3.0.bbbbbbbb",
	]);
});

test("checkNow single-flights while a check is running", async () => {
	let resolveLatest: ((value: ForkRelease | null) => void) | undefined;
	let calls = 0;
	const controller = createForkUpdateController({
		enabled: true,
		version: "0.2.0.aaaaaaaa",
		latestRelease: () => {
			calls += 1;
			return new Promise<ForkRelease | null>((resolve) => {
				resolveLatest = resolve;
			});
		},
		notify: () => {},
		openExternal: () => {},
		windowFocused: () => false,
		random: () => 0.5,
		schedule: () => () => {},
	});
	const first = controller.checkNow();
	const second = controller.checkNow();
	resolveLatest?.(release("0.3.0.bbbbbbbb"));
	await Promise.all([first, second]);
	await settle();
	expect(calls).toBe(1);
	expect((await controller.getState()).availableVersion).toBe("0.3.0.bbbbbbbb");
});

test("publishes nothing to listeners after dispose", async () => {
	const { controller, scheduled } = harness();
	const seen: string[] = [];
	controller.subscribe((state) => seen.push(state.status));
	controller.start();
	await settle();
	controller.dispose();
	await controller.checkNow();
	await settle();
	expect(seen).toEqual(["checking", "available"]);
	expect(scheduled.every((entry) => entry.cancelled)).toBe(true);
});

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("fetches and parses the fork's latest release with one bounded request", async () => {
	const requests: string[] = [];
	const found = await fetchLatestForkRelease(async (url) => {
		requests.push(url);
		return jsonResponse({ tag_name: "v0.3.0.1a2b3c4d", draft: false, prerelease: false });
	});
	expect(found).toEqual({ version: "0.3.0.1a2b3c4d", tag: "v0.3.0.1a2b3c4d" });
	expect(requests).toEqual([
		"https://api.github.com/repos/caozisheng/oh-my-thinkrail/releases/latest",
	]);
});

test("treats a refused request or unusable payload as no answer", async () => {
	const refused = await fetchLatestForkRelease(async () =>
		jsonResponse({ message: "rate limited" }, 403),
	);
	expect(refused).toBeNull();
	const notARelease = await fetchLatestForkRelease(async () =>
		jsonResponse({ tag_name: "nightly" }),
	);
	expect(notARelease).toBeNull();
});
