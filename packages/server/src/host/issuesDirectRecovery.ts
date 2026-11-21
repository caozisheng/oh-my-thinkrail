import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CodedError } from "@thinkrail/shared/codedError";
import type { IssueConfirmationStore } from "./issueConfirmations";

function blocked(): never {
	throw new CodedError(
		"ISSUE_CONFIRMATION_BLOCKED",
		"No safe observed-result recovery is available. Inspect the original operation and resolve its active execution or missing/changed remote evidence; do not resend or use a replacement operation ID. The uncertain write remains fenced.",
	);
}

/**
 * Read-only adoption of the original operation's observed result, never a retry.
 * The caller owns session/binding/request validation and completed-receipt replay.
 * observe must freshly validate the frozen payload against remote facts and return
 * bounded JSON containing result, or reject when success cannot be established.
 * Absence of a remote write is not evidence permitting the intent to be unlocked.
 */
export async function reconcileDirectOperation({
	sessionId,
	operationId,
	store,
	observe,
}: {
	sessionId: string;
	operationId: string;
	store: IssueConfirmationStore;
	observe: (payload: unknown) => Promise<unknown>;
}): Promise<unknown> {
	if (
		typeof store.inspect !== "function" ||
		typeof store.prepareRecovery !== "function" ||
		typeof store.completeRecovery !== "function"
	)
		blocked();
	const state = await store.inspect(sessionId, operationId);
	// In particular, do not expose a completed receipt without the host's replay checks.
	if (state.status !== "uncertain") return { status: state.status };
	try {
		// Snapshot before freezing: an observer retaining/mutating its return value must
		// not change what the second observation is compared with.
		const candidate: unknown = JSON.parse(JSON.stringify(await observe(state.payload)));
		const frozen = await store.prepareRecovery(sessionId, operationId, candidate);
		const token = `host-reconcile:${createHash("sha256")
			.update(JSON.stringify([sessionId, operationId, state.digest, frozen.candidateDigest]))
			.digest("hex")}`;
		return await store.completeRecovery(
			sessionId,
			operationId,
			frozen.candidateDigest,
			token,
			async () => {
				if (!isDeepStrictEqual(await observe(state.payload), candidate)) blocked();
			},
		);
	} catch {
		// Provider errors may contain sensitive details, and none prove non-dispatch.
		blocked();
	}
}
