import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CodedError } from "@thinkrail/shared/codedError";
import { type Static, Type } from "typebox";

export const ISSUE_CONTEXT_TOOL_NAME = "issue_context";
export const ISSUE_RECORD_SUMMARY_TOOL_NAME = "issue_record_summary";
export const ISSUE_JOIN_REPOSITORY_TOOL_NAME = "issue_join_repository";

export const ISSUE_TOOL_NAMES = [
	ISSUE_CONTEXT_TOOL_NAME,
	"issue_delete_note",
	ISSUE_RECORD_SUMMARY_TOOL_NAME,
	ISSUE_JOIN_REPOSITORY_TOOL_NAME,
	"issue_prepare_confirmation",
	"issue_execute_confirmation",
	"issue_run_operation",
] as const;

export type IssueSummaryRecovery = "reconcile" | "retry-confirmed-unpublished";

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });
const RecordSummarySchema = Type.Object(
	{
		operationId: Type.String({
			minLength: 1,
			maxLength: 128,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
		}),
		recovery: Type.Optional(
			Type.Union([Type.Literal("reconcile"), Type.Literal("retry-confirmed-unpublished")]),
		),
		summary: Type.String({
			minLength: 1,
			maxLength: 32_000,
			pattern: "\\S",
			description: "Nonblank summary, at most 32,000 UTF-8 bytes.",
		}),
	},
	{ additionalProperties: false },
);

const JoinRepositorySchema = Type.Object(
	{
		projectId: Type.String({
			minLength: 1,
			maxLength: 256,
			pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$",
			description: 'The projectId of a repository issue_context lists with role "reference".',
		}),
	},
	{ additionalProperties: false },
);

type EmptyParams = Static<typeof EmptyParamsSchema>;
type JoinRepositoryParams = Static<typeof JoinRepositorySchema>;
/** A repository the bound Issue may join, or the worktree it joined as. */
export type IssueJoinedRepository = {
	projectId: string;
	name: string;
	path: string;
	workspaceId?: string;
};
type RecordSummaryParams = Static<typeof RecordSummarySchema>;
type SummaryResult = { noteId: number; url?: string };

export interface IssueToolHost {
	context(sessionId: string): Promise<string>;
	deleteNote?(sessionId: string, noteId: number): Promise<{ noteId: number; deleted: true }>;
	prepareConfirmation?(
		sessionId: string,
		input: {
			operationId: string;
			inspect?: boolean;
			continueDespiteChecks?: boolean;
			normalizeWorkflowLabel?: boolean;
			workflowTarget?: "workflow::in-progress" | "workflow::in-review" | "workflow::done";
			recovery?: "reconcile";
			report?: string;
			projectId?: string;
			title?: string;
			body?: string;
			targetBranch?: string;
			pushMode?: "force-with-lease";
			action?:
				| "update-body"
				| "close-issue"
				| "ready-mr"
				| "merge-mr"
				| "record-delivery-state"
				| "read-delivery-state"
				| "authorize-automation"
				| "advance-automation"
				| "preflight-dependencies";
			reason?: string;
			acceptance?: string;
			mergeRequestId?: number;
			expectedSha?: string;
			expectedRevision?: number;
			deliveryState?: unknown;
			mode?: "draft" | "auto-merge" | "manual";
			closeIssue?: boolean;
		},
	): Promise<unknown>;
	runOperation?(
		sessionId: string,
		input: Static<typeof PrepareConfirmationSchema>,
	): Promise<unknown>;
	executeConfirmation?(
		sessionId: string,
		operationId: string,
		toolCallId: string,
		continuationId?: string,
	): Promise<unknown>;
	recordSummary(
		sessionId: string,
		operationId: string,
		summary: string,
		recovery?: IssueSummaryRecovery,
	): Promise<SummaryResult>;
	/** A `reference` repository of this implementation session's Issue; refuses anything else. */
	joinCandidate?(sessionId: string, projectId: string): Promise<IssueJoinedRepository>;
	/** Join it (after the user confirmed) and return its new Issue worktree. */
	joinRepository?(sessionId: string, projectId: string): Promise<IssueJoinedRepository>;
}

const UNAVAILABLE_MESSAGE = "Issue tools are unavailable for this session.";
const INVALID_MESSAGE = "Invalid Issue tool parameters.";
const unavailable = () => new CodedError("RESOURCE_UNAVAILABLE", UNAVAILABLE_MESSAGE);
const invalid = () => new CodedError("RANGE_INVALID", INVALID_MESSAGE);
const defaultHost: IssueToolHost = {
	context: async () => {
		throw unavailable();
	},
	recordSummary: async () => {
		throw unavailable();
	},
};
let host: IssueToolHost = defaultHost;

export function setIssueToolHost(next: IssueToolHost | null): void {
	host = next ?? defaultHost;
}

function validEmptyParams(value: unknown): value is EmptyParams {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Reflect.ownKeys(value).length === 0
	);
}

function validRecordSummaryParams(value: unknown): value is RecordSummaryParams {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const params = value as Record<string, unknown>;
	if (
		Reflect.ownKeys(params).some(
			(key) =>
				!["operationId", "summary", "recovery"].includes(String(key)) || typeof key !== "string",
		) ||
		(Object.hasOwn(params, "recovery") &&
			params.recovery !== "reconcile" &&
			params.recovery !== "retry-confirmed-unpublished") ||
		!Object.hasOwn(params, "operationId") ||
		!Object.hasOwn(params, "summary") ||
		typeof params.operationId !== "string" ||
		typeof params.summary !== "string"
	)
		return false;
	return (
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(params.operationId) &&
		params.summary.trim().length > 0 &&
		new TextEncoder().encode(params.summary).byteLength <= 32_000
	);
}

const DeleteNoteSchema = Type.Object(
	{ noteId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) },
	{ additionalProperties: false },
);
export function createIssueDeleteNoteTool(): ToolDefinition<
	typeof DeleteNoteSchema,
	{ noteId: number; deleted: true }
> {
	return {
		name: "issue_delete_note",
		label: "Delete Issue Comment",
		description:
			"Delete one explicitly requested comment from this session's bound Issue by noteId. Irreversible, single attempt; never automatically retry a failed or uncertain delete. No other Issue or repository can be selected.",
		parameters: DeleteNoteSchema,
		async execute(_id, params, _signal, _update, ctx) {
			if (
				!params ||
				Reflect.ownKeys(params).length !== 1 ||
				!Object.hasOwn(params, "noteId") ||
				!Number.isSafeInteger(params.noteId) ||
				params.noteId < 1
			)
				throw invalid();
			if (!host.deleteNote) throw unavailable();
			const result = await host.deleteNote(ctx.sessionManager.getSessionId(), params.noteId);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}

export function createIssueContextTool(): ToolDefinition<typeof EmptyParamsSchema, undefined> {
	return {
		name: ISSUE_CONTEXT_TOOL_NAME,
		label: "Issue Context",
		description: "Read the issue context associated with this session, if one is available.",
		parameters: EmptyParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!validEmptyParams(params)) throw invalid();
			try {
				const text = await host.context(ctx.sessionManager.getSessionId());
				return { content: [{ type: "text", text }], details: undefined };
			} catch {
				throw unavailable();
			}
		},
	};
}

export function createIssueRecordSummaryTool(): ToolDefinition<
	typeof RecordSummarySchema,
	SummaryResult
> {
	return {
		name: ISSUE_RECORD_SUMMARY_TOOL_NAME,
		label: "Record Issue Summary",
		description:
			"Summary publication is best-effort, not a work or session-completion gate. Before handing off Issue work, attempt a concise summary of decisions, results, validation and next steps when no prior summary write remains unresolved. Generate a unique operationId for each summary; reuse it only for the identical summary. Claim publication only with a confirmed noteId. On failure or uncertainty, stop publication and report work results and publication status separately in chat. Do not ask for recovery authorization merely to end the session. Defer recovery unless explicitly requested; obtain explicit HUMAN confirmation before either recovery mode, then reuse the ORIGINAL operationId and EXACT summary. Selecting recovery represents that confirmation; an agent must not infer it. reconcile only recovers a unique exact-body receipt without sending; it does not prove original authorship, so the human must confirm adopting that receipt. retry-confirmed-unpublished requires human confirmation that the original request/process ended and remote publication did not happen, plus authorization to retry. Absence, errors and timeouts are NOT proof. Legacy intents can retry once with that confirmation and fresh zero exact matches; already-retried attempts cannot resend. Never change operationId to bypass uncertainty.",
		parameters: RecordSummarySchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!validRecordSummaryParams(params)) throw invalid();
			try {
				const result = await host.recordSummary(
					ctx.sessionManager.getSessionId(),
					params.operationId,
					params.summary,
					...(params.recovery ? [params.recovery] : []),
				);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: result,
				};
			} catch (error) {
				if (error instanceof CodedError && error.code === "ISSUE_SUMMARY_RECOVERY_REQUIRED") {
					throw new CodedError(
						"ISSUE_SUMMARY_RECOVERY_REQUIRED",
						"Issue summary publication is unconfirmed; work and session completion are not blocked. Report publication status in chat and defer recovery unless explicitly requested. Do not resend or change operationId. Recovery requires explicit human confirmation and the original operationId and exact summary. Absence, errors and timeouts are not proof of nonpublication.",
					);
				}
				throw unavailable();
			}
		},
	};
}

function validJoinParams(value: unknown): value is JoinRepositoryParams {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Reflect.ownKeys(value);
	const projectId = (value as Record<string, unknown>).projectId;
	return (
		keys.length === 1 &&
		keys[0] === "projectId" &&
		typeof projectId === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(projectId)
	);
}

type JoinResult = { joined: boolean; repository?: IssueJoinedRepository };

/** Ask the user to join one `reference` repository to the running Issue implementation. */
export function createIssueJoinRepositoryTool(): ToolDefinition<
	typeof JoinRepositorySchema,
	JoinResult
> {
	return {
		name: ISSUE_JOIN_REPOSITORY_TOOL_NAME,
		label: "Join Issue Repository",
		description:
			'During Issue implementation, request that a repository listed with role "reference" (read-only) join this Issue so it can be changed. The user must confirm; on success the host creates its Issue worktree and returns its path, which is the only place to edit that repository. A declined request means: do not change that repository.',
		parameters: JoinRepositorySchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!validJoinParams(params)) throw invalid();
			const sessionId = ctx.sessionManager.getSessionId();
			let candidate: IssueJoinedRepository;
			try {
				if (!host.joinCandidate) throw unavailable();
				candidate = await host.joinCandidate(sessionId, params.projectId);
			} catch {
				throw unavailable();
			}
			if (!ctx.hasUI)
				throw new CodedError(
					"RESOURCE_UNAVAILABLE",
					"Joining a repository needs the user's confirmation, which this session cannot ask for.",
				);
			const confirmed = await ctx.ui.confirm(
				`Join ${candidate.name} to this Issue?`,
				`The agent asks to change ${candidate.name} (${candidate.path}). ThinkRail will create an Issue worktree for it, branched from its freshly fetched default branch, next to the Issue's other worktrees.`,
			);
			if (!confirmed) {
				const text = `The user declined joining ${candidate.name}. Do not change that repository; continue without it or ask the user.`;
				return { content: [{ type: "text", text }], details: { joined: false } };
			}
			let joined: IssueJoinedRepository;
			try {
				if (!host.joinRepository) throw unavailable();
				joined = await host.joinRepository(sessionId, params.projectId);
			} catch (error) {
				if (error instanceof CodedError && error.code === "ISSUE_REPOSITORY_REFUSED") throw error;
				throw unavailable();
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ joined: true, repository: joined }) }],
				details: { joined: true, repository: joined },
			};
		},
	};
}

const PrepareConfirmationSchema = Type.Object(
	{
		operationId: Type.String({
			minLength: 1,
			maxLength: 128,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
		}),
		action: Type.Optional(
			Type.Union([
				Type.Literal("update-body"),
				Type.Literal("close-issue"),
				Type.Literal("ready-mr"),
				Type.Literal("merge-mr"),
				Type.Literal("record-delivery-state"),
				Type.Literal("read-delivery-state"),
				Type.Literal("authorize-automation"),
				Type.Literal("advance-automation"),
				Type.Literal("preflight-dependencies"),
			]),
		),
		mode: Type.Optional(
			Type.Union([Type.Literal("draft"), Type.Literal("auto-merge"), Type.Literal("manual")]),
		),
		closeIssue: Type.Optional(Type.Boolean()),
		mergeRequestId: Type.Optional(Type.Integer({ minimum: 1 })),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
		deliveryState: Type.Optional(Type.Unknown()),
		expectedSha: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{40}$" })),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
		acceptance: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
		inspect: Type.Optional(Type.Boolean()),
		continueDespiteChecks: Type.Optional(Type.Boolean()),
		normalizeWorkflowLabel: Type.Optional(Type.Boolean()),
		workflowTarget: Type.Optional(
			Type.Union([
				Type.Literal("workflow::in-progress"),
				Type.Literal("workflow::in-review"),
				Type.Literal("workflow::done"),
			]),
		),
		recovery: Type.Optional(Type.Literal("reconcile")),
		report: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
		projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		body: Type.Optional(
			Type.String({
				maxLength: 32000,
				description: "Complete Issue body replacement, at most 32,000 UTF-8 bytes.",
			}),
		),
		targetBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		pushMode: Type.Optional(Type.Literal("force-with-lease")),
	},
	{ additionalProperties: false },
);
const ExecuteConfirmationSchema = Type.Object(
	{
		operationId: Type.String({ minLength: 1, maxLength: 128 }),
		toolCallId: Type.String({ minLength: 1, maxLength: 512 }),
		continuationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);
export function createIssuePrepareConfirmationTool(): ToolDefinition<
	typeof PrepareConfirmationSchema,
	unknown
> {
	return {
		name: "issue_prepare_confirmation",
		label: "Prepare Issue Confirmation",
		parameters: PrepareConfirmationSchema,
		description:
			"Record/read structured per-repository delivery state; authorize and advance per-repository lifecycle policies using action:'authorize-automation' and action:'advance-automation' with the same operationId/projectId. Before changing a downstream pairing, call action:'preflight-dependencies' with its projectId; this reads exact upstream merged requests and target SHAs. It blocks when host-verified API/ABI/protocol compatibility evidence is unavailable—do not substitute independent CI. Policy advancement also requires host-observed validation evidence bound to the exact SHA/tree/target; agent-reported validation never qualifies. For read-only PR/MR state, head, target SHA, pipeline and provider readiness, use action:'ready-mr' or action:'merge-mr' with inspect:true, projectId and mergeRequestId; include expectedSha and targetBranch when known. This does not create a confirmation or mutate the request. To inspect a journal operation, omit action and use inspect:true with its operationId. Other actions independently confirm MR ready/merge, Issue close, body replacement, stage report and Draft delivery. Delivery defaults to ordinary non-force push. Only for an explicitly requested per-repository update of an existing opened same-repository PR/MR, use pushMode:'force-with-lease'; its exact card freezes the observed remote head and replacement SHA. Never select it through autonomous policy, for creation, inspection, recovery or unrelated actions. No implicit lease, unconditional force or retry is permitted. Pass returned confirmation questions unchanged to ask_user_question. Never bypass host operations through shell.",
		async execute(_id, params, _signal, _update, ctx) {
			if (
				params.pushMode !== undefined &&
				(params.pushMode !== "force-with-lease" ||
					!params.projectId ||
					params.action ||
					params.inspect ||
					params.recovery ||
					params.report)
			)
				throw invalid();
			if (
				params.action === "update-body" &&
				(!Object.hasOwn(params, "body") ||
					new TextEncoder().encode(params.body ?? "").byteLength > 32_000)
			)
				throw invalid();
			if (!host.prepareConfirmation) throw unavailable();
			const result = await host.prepareConfirmation(ctx.sessionManager.getSessionId(), params);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}
export function createIssueExecuteConfirmationTool(): ToolDefinition<
	typeof ExecuteConfirmationSchema,
	unknown
> {
	return {
		name: "issue_execute_confirmation",
		label: "Execute Issue Confirmation",
		parameters: ExecuteConfirmationSchema,
		description:
			"Execute a prepared Issue operation only after the exact returned question was submitted with Looks right. Supply that ask_user_question toolCallId. Host validates the real answer, fixed version and one-time durable intent. Results may be partial/uncertain: stop and reconcile, never retry under a new operationId or bypass through shell. When a refusal returns continuation questions, show them unchanged and pass continuationId with that card's real toolCallId to attempt the fixed request once. Stage confirmation does not authorize push or PR/MR creation; those require their own per-repository card.",
		async execute(_id, params, _signal, _update, ctx) {
			if (!host.executeConfirmation) throw unavailable();
			const result = await host.executeConfirmation(
				ctx.sessionManager.getSessionId(),
				params.operationId,
				params.toolCallId,
				params.continuationId,
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}
export function createIssueRunOperationTool(): ToolDefinition<
	typeof PrepareConfirmationSchema,
	unknown
> {
	return {
		name: "issue_run_operation",
		label: "Run Issue Operation",
		parameters: PrepareConfirmationSchema,
		description:
			"Run an explicitly requested Issue mutation in this bound session without an extra confirmation card. Omit action for stage publication; set workflowTarget and normalizeWorkflowLabel to advance the workflow label, with workflow::done requiring a host-observed merge receipt. Use projectId/title/body for Draft delivery; update-body, ready-mr, merge-mr or close-issue only when explicitly requested. Exact-lease push uses the observed remote head and exact new SHA. The host validates current identity/state and journals every write. Reusing the same operationId returns a completed result or refuses a changed/uncertain operation without resending. Set recovery:'reconcile' with the original operationId to adopt a freshly observed successful result; this never sends a write and never unlocks when success cannot be proven. Inspection and cross-repository state operations use issue_prepare_confirmation.",
		async execute(_id, params, _signal, _update, ctx) {
			if (!host.runOperation) throw unavailable();
			const result = await host.runOperation(ctx.sessionManager.getSessionId(), params);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}
export function issueToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool(createIssueContextTool());
	pi.registerTool(createIssueDeleteNoteTool());
	pi.registerTool(createIssueRecordSummaryTool());
	pi.registerTool(createIssueJoinRepositoryTool());
	pi.registerTool(createIssuePrepareConfirmationTool());
	pi.registerTool(createIssueExecuteConfirmationTool());
	pi.registerTool(createIssueRunOperationTool());
}
