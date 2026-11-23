import type { SessionEventPayload } from "@thinkrail/contracts";

export interface MatrixLiveScheduler {
	schedule(work: () => void, delay: number): () => void;
}
const scheduler: MatrixLiveScheduler = {
	schedule(work, delay) {
		const timer = setTimeout(work, delay);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

/** Occurrence zero retains the original timestamp key for existing durable receipts. */
export function assistantMessageKey(timestamp: number, occurrence: number): string {
	return occurrence === 0 ? String(timestamp) : `${timestamp}:${occurrence}`;
}

/** One bounded mailbox and one queued drain per bridge, never one task per token. */
export function createMatrixLiveEvents(options: {
	allowed(): boolean;
	enqueue(work: () => Promise<void>): Promise<void>;
	stream(sessionId: string, key: string, message: unknown, final: boolean): Promise<void>;
	reconcile(): Promise<void>;
	scheduler?: MatrixLiveScheduler;
}) {
	const clock = options.scheduler ?? scheduler;
	const pending = new Map<
		string,
		{ sessionId: string; key: string; message: unknown; final: boolean }
	>();
	// Count message boundaries, not snapshots: repeated partials share one identity.
	const occurrences = new Map<string, { occurrence: number; ended: boolean }>();
	const mappedSessions = new Set<string>();
	let disposed = false;
	let cancel: (() => void) | undefined;
	let urgent = false;
	let reconcile = false;
	let running: Promise<void> | undefined;
	const allowed = () => !disposed && options.allowed();
	const clear = () => {
		cancel?.();
		cancel = undefined;
		pending.clear();
		mappedSessions.clear();
		reconcile = false;
		urgent = false;
	};
	const schedule = (immediate: boolean) => {
		if (!allowed()) {
			clear();
			return;
		}
		if (immediate && !urgent) {
			cancel?.();
			cancel = undefined;
		}
		urgent ||= immediate;
		if (running || cancel) return;
		cancel = clock.schedule(
			() => {
				cancel = undefined;
				void drain();
			},
			urgent ? 0 : 1000,
		);
	};
	const drain = (): Promise<void> => {
		if (running) return running;
		if (!allowed()) {
			clear();
			return Promise.resolve();
		}
		cancel?.();
		cancel = undefined;
		running = options
			.enqueue(async () => {
				if (!allowed()) {
					clear();
					return;
				}
				const shouldReconcile = reconcile;
				reconcile = false;
				urgent = false;
				// Never postpone catalog/mapping work behind a continuously replenished
				// token mailbox. Keep snapshots until new session rooms exist.
				if (shouldReconcile) {
					try {
						await options.reconcile();
					} catch (error) {
						reconcile = true;
						throw error;
					}
				}
				const batch = [...pending.values()];
				pending.clear();
				for (const item of batch) {
					if (!allowed()) return;
					await options.stream(item.sessionId, item.key, item.message, item.final);
				}
			})
			.finally(() => {
				running = undefined;
				if (pending.size || reconcile) schedule(urgent);
			});
		return running;
	};
	return {
		observe(payload: SessionEventPayload) {
			if (!allowed()) return;
			const { event, sessionId } = payload;
			if (event.type === "agent_settled") {
				reconcile = true;
				schedule(true);
				return;
			}
			if (
				event.type !== "message_start" &&
				event.type !== "message_update" &&
				event.type !== "message_end"
			)
				return;
			const message = event.message;
			if (message.role !== "assistant" || !Number.isFinite(message.timestamp)) return;
			const boundaryId = JSON.stringify([sessionId, message.timestamp]);
			let boundary = occurrences.get(boundaryId);
			if (!boundary) {
				boundary = { occurrence: 0, ended: false };
				occurrences.set(boundaryId, boundary);
			} else if (event.type === "message_start") {
				boundary.occurrence++;
				boundary.ended = false;
			}
			if (event.type === "message_start") return;
			if (boundary.ended && event.type !== "message_end") return;
			boundary.ended ||= event.type === "message_end";
			const content = message.content.filter((block) => block.type === "text");
			if (!content.length) return;
			const key = assistantMessageKey(message.timestamp, boundary.occurrence);
			if (!mappedSessions.has(sessionId)) {
				mappedSessions.add(sessionId);
				reconcile = true;
			}
			const id = JSON.stringify([sessionId, key]);
			if (!pending.has(id) && pending.size >= 128) {
				reconcile = true;
				schedule(true);
				return;
			}
			const previous = pending.get(id);
			if (previous?.final && event.type !== "message_end") return;
			pending.set(id, {
				sessionId,
				key,
				message: { role: "assistant", timestamp: message.timestamp, content },
				final: event.type === "message_end",
			});
			schedule(event.type === "message_end");
		},
		stateChanged() {
			if (!allowed()) return;
			reconcile = true;
			schedule(true);
		},
		sync() {
			if (!allowed()) return Promise.resolve();
			// Repeated periodic/manual requests join the existing drain, not a queue of reconciles.
			if (running) return running;
			reconcile = true;
			return drain();
		},
		pause: clear,
		dispose() {
			disposed = true;
			clear();
		},
	};
}
