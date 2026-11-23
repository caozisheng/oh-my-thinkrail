import { expect, test } from "bun:test";
import type { SessionEventPayload } from "@thinkrail/contracts";
import { createMatrixLiveEvents, type MatrixLiveScheduler } from "./liveEvents";

function fixture() {
	let now = 0;
	let id = 0;
	const timers = new Map<number, { at: number; work: () => void }>();
	const scheduler: MatrixLiveScheduler = {
		schedule(work, delay) {
			const key = ++id;
			timers.set(key, { at: now + delay, work });
			return () => {
				timers.delete(key);
			};
		},
	};
	const calls: string[] = [];
	let online = true;
	const live = createMatrixLiveEvents({
		scheduler,
		allowed: () => online,
		enqueue: (work) => work(),
		stream: async (session, key, message, final) => {
			calls.push(`${session}:${key}:${JSON.stringify(message)}:${final}`);
		},
		reconcile: async () => {
			calls.push("reconcile");
		},
	});
	const tick = async (ms: number) => {
		now += ms;
		for (const [key, timer] of [...timers])
			if (timer.at <= now) {
				timers.delete(key);
				timer.work();
			}
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	const message = (text: string, type = "message_update", timestamp = 42) =>
		live.observe({
			sessionId: "s",
			event: {
				type,
				message: {
					role: "assistant",
					timestamp,
					content: [
						{ type: "thinking", thinking: "secret" },
						{ type: "text", text },
					],
				},
			},
		} as SessionEventPayload);
	return {
		live,
		calls,
		timers,
		tick,
		message,
		offline: () => {
			online = false;
		},
	};
}

test("token snapshots coalesce with a trailing flush and filter private blocks", async () => {
	const f = fixture();
	for (let i = 0; i < 10000; i++) f.message(String(i));
	expect(f.timers.size).toBe(1);
	await f.tick(999);
	expect(f.calls).toEqual([]);
	await f.tick(1);
	expect(f.calls).toHaveLength(2);
	expect(f.calls[0]).toBe("reconcile");
	expect(f.calls[1]).toContain("9999");
	expect(f.calls[1]).not.toContain("secret");
});

test("reconciliation maps sessions before final snapshots flush in message order", async () => {
	const f = fixture();
	f.message("partial");
	f.message("final", "message_end");
	f.message("next", "message_end", 43);
	f.live.observe({ sessionId: "s", event: { type: "agent_settled", terminal: null } });
	await f.tick(0);
	expect(f.calls).toHaveLength(3);
	expect(f.calls[0]).toBe("reconcile");
	expect(f.calls[1]).toContain("final");
	expect(f.calls[2]).toContain("next");
});

test("state changes coalesce; offline and disposed callbacks do no work", async () => {
	const f = fixture();
	for (let i = 0; i < 1000; i++) f.live.stateChanged();
	expect(f.timers.size).toBe(1);
	await f.tick(0);
	expect(f.calls).toEqual(["reconcile"]);
	f.message("late");
	f.offline();
	await f.tick(1000);
	f.message("ignored");
	f.live.stateChanged();
	expect(f.timers.size).toBe(0);
	f.live.dispose();
	await f.tick(5000);
	expect(f.calls).toEqual(["reconcile"]);
});

test("a blocked drain bounds queued work and disposal prevents later operations", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let queued = 0;
	let reconciles = 0;
	let streams = 0;
	const live = createMatrixLiveEvents({
		allowed: () => true,
		enqueue: async (work) => {
			queued++;
			await gate;
			await work();
		},
		stream: async () => {
			streams++;
		},
		reconcile: async () => {
			reconciles++;
		},
	});
	const first = live.sync();
	for (let i = 0; i < 10000; i++) {
		live.stateChanged();
		void live.sync();
		live.observe({
			sessionId: "s",
			event: {
				type: "message_end",
				message: { role: "assistant", timestamp: i, content: [{ type: "text", text: "latest" }] },
			},
		} as SessionEventPayload);
	}
	expect(queued).toBe(1);
	live.dispose();
	release();
	await first;
	expect(streams).toBe(0);
	expect(reconciles).toBe(0);
});

test("same-millisecond message boundaries keep distinct keys and repeated partials coalesce", async () => {
	const f = fixture();
	f.message("", "message_start");
	f.message("first partial");
	f.message("first", "message_end");
	f.message("", "message_start");
	f.message("second partial");
	f.message("second partial again");
	f.message("second", "message_end");
	await f.tick(0);
	expect(f.calls).toHaveLength(3);
	expect(f.calls[1]).toContain("s:42:");
	expect(f.calls[1]).toContain('"text":"first"');
	expect(f.calls[2]).toContain("s:42:1:");
	expect(f.calls[2]).toContain('"text":"second"');
});

test("continuous snapshots cannot starve reconciliation and unmapped first snapshots survive", async () => {
	const calls: string[] = [];
	let mapped = false;
	let serial = 0;
	const snapshot = () =>
		live.observe({
			sessionId: "s",
			event: {
				type: "message_update",
				message: {
					role: "assistant",
					timestamp: 42,
					content: [{ type: "text", text: String(++serial) }],
				},
			},
		} as SessionEventPayload);
	const live = createMatrixLiveEvents({
		allowed: () => true,
		enqueue: (work) => work(),
		scheduler: { schedule: () => () => {} },
		reconcile: async () => {
			calls.push("reconcile");
			mapped = true;
			snapshot(); // Tokens arrive even while reconciliation awaits I/O.
		},
		stream: async () => {
			expect(mapped).toBe(true);
			calls.push("stream");
			live.stateChanged();
			snapshot(); // Every stream leaves the mailbox nonempty.
		},
	});
	snapshot();
	await live.sync();
	await live.sync();
	expect(calls).toEqual(["reconcile", "stream", "reconcile", "stream"]);
	live.dispose();
});
