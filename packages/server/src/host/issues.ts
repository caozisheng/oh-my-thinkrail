import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TranscriptMessage } from "@thinkrail/contracts";
import {
	canonicalIssueInstanceUrl,
	hasIssueProjectTrust,
	ISSUES_DESIGN_APPROVAL_PROTOCOL_VERSION,
	type IssueReference,
	type IssueTarget,
	isIssueConnectionInput,
	isIssueTarget,
	issueProviderForInstanceUrl,
	type WorkspaceIssueBinding,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	getSessionMessages,
	isTrustedQuestionnaireReceipt,
	readArchivedSessionTranscript,
	sessionReuseStatus,
	startInitialSessionPrompt,
} from "../agent";
import { gitAsync, originUrls, readPushBranchSha } from "../git";
import {
	createIssuesService,
	type IssueCredentialStore,
	type IssueStoredBinding,
	type IssuesService,
	type IssuesServiceOptions,
	type WorkflowRecord,
} from "../issues";
import { logger } from "../log";
import { dataDir } from "../persistence";
import { getProjects } from "../projects";
import { getConfig } from "../settings";
import { getWorkspace } from "../workspaces";
import {
	createIssueAgentSessionHost,
	type IssueAgentSessionHostOptions,
} from "./issueAgentSessions";
import {
	createIssueAutomationActions,
	type IssueAutomationPolicy,
	policyQuestions,
} from "./issueAutomationActions";
import {
	createIssueBodyActions,
	type IssueBodyPayload,
	issueBodyQuestions,
} from "./issueBodyActions";
import {
	createIssueCloseActions,
	type IssueClosePayload,
	issueCloseQuestions,
} from "./issueCloseActions";
import { runIssueCompatibility } from "./issueCompatibility";
import {
	createIssueConfirmationStore,
	type IssueConfirmationInspection,
} from "./issueConfirmations";
import { createIssueContinuations } from "./issueContinuations";
import { createIssueCredentials } from "./issueCredentials";
import {
	createIssueDeliveryActions,
	type DeliveryPayload,
	deliveryQuestions,
} from "./issueDeliveryActions";
import { createIssueDeliveryStateActions } from "./issueDeliveryStateActions";
import { createIssueDeliveryStatePersistence } from "./issueDeliveryStatePersistence";
import {
	createIssueMergeRequestActions,
	type MergeRequestPayload,
	mergeRequestQuestions,
} from "./issueMergeRequestActions";
import {
	createIssueRepositoryDependencies,
	type IssueDependencyRepository,
} from "./issueRepositoryDependencies";
import {
	createIssueSessionStore,
	type IssueSessionAssociation,
	type IssueSessionStore,
} from "./issueSessions";
import { createIssueStageActions, type StagePayload, stageQuestions } from "./issueStageActions";
import { createIssuesActions, type IssueActionSessions, privateDirectory } from "./issuesActions";
import { reconcileDirectOperation } from "./issuesDirectRecovery";
import { createIssueWorkflowPersistence } from "./issueWorkflowPersistence";
import { createIssueWorkspacePersistence } from "./issueWorkspacePersistence";

function invalid(message = "Invalid Issue request."): never {
	throw new CodedError("RANGE_INVALID", message);
}
function invalidReceipt(): never {
	const error = new CodedError(
		"ISSUE_CONFIRMATION_BLOCKED",
		"Issue confirmation blocked (confirmation_mismatch). Submit the exact Looks right receipt for the displayed card.",
	);
	Object.assign(error, { reason: "confirmation_mismatch" });
	throw error;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
	return (
		Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
	);
}
const connectionKeys = ["instanceUrl", "projectId", "token"];
function request(
	params: unknown,
	connect = false,
): Record<string, unknown> & { projectId: string } {
	if (
		!record(params) ||
		!exact(params, connect ? ["projectId", "input"] : ["projectId"]) ||
		typeof params.projectId !== "string" ||
		!params.projectId.trim()
	)
		invalid();
	if (connect) {
		if (!record(params.input)) invalid();
		const keys = Object.keys(params.input);
		if (
			connectionKeys.some((key) => !keys.includes(key)) ||
			keys.some((key) => ![...connectionKeys, "httpConsent", "scope"].includes(key)) ||
			!isIssueConnectionInput(params.input)
		)
			invalid();
	}
	return params as Record<string, unknown> & { projectId: string };
}
function project(projectId: string, trusted: boolean) {
	const found = getProjects().find((candidate) => candidate.id === projectId);
	if (!found || found.kind === "chats" || (found.kind === "group" && found.closed))
		throw new CodedError("RESOURCE_UNAVAILABLE", "Issue project is unavailable.");
	if (trusted && found.kind !== "group" && !hasIssueProjectTrust(found))
		throw new CodedError("RESOURCE_UNAVAILABLE", "Issue project requires trust.");
	return found;
}

/** Exact shared target only: no caller version, path, actor or credential reaches the read. */
function designTarget(params: unknown): IssueTarget {
	if (!isIssueTarget(params)) invalid();
	return { projectId: params.projectId, reference: { ...params.reference } };
}

/**
 * A design receipt is readable only while it is settled (`approved` and not pending); the
 * digest is the receipt's own publication version, never a re-derived or caller-supplied one.
 * Implementation receipts are deliberately not consulted.
 */
function approvedDesignVersion(record: WorkflowRecord | null): string | null {
	const design = record?.design;
	if (!record || record.pending || design?.approved !== true) return null;
	return design.publication.version;
}

/**
 * Exactly one remote named `origin`, read from local config only: no fetch, no credential
 * helper, no network. Several remotes or a differently named one are ambiguous, never guessed.
 */
async function originRepositoryUrl(path: string): Promise<string | null> {
	const remotes = await gitAsync(path, ["remote"]);
	if (!remotes.ok) return null;
	const names = remotes.out.split(/\r?\n/).filter((name) => name !== "");
	if (names.length !== 1 || names[0] !== "origin") return null;
	return safeRepositoryUrl((await originUrls(path)).fetch);
}

/**
 * Credential-free canonical HTTP(S) only, normalized for exact destination comparison:
 * SSH/SCP, userinfo, query and fragment forms all stay null. The web resolver parses
 * the instance/project split; this never echoes git output.
 */
function safeRepositoryUrl(value: string | null): string | null {
	if (value === null) return null;
	const address = value.replace(/\/+$/, "");
	return canonicalIssueInstanceUrl(address);
}

/** Local-only URL validation; never contacts a remote or echoes config. */
export async function deliveryPushUrl(path: string, configuredUrl: string): Promise<string | null> {
	// No scope flag: includes system/global/local config and includes. Refuse every rule,
	// including pushInsteadOf, which ls-remote --get-url does not apply.
	const rewrites = await gitAsync(
		path,
		["config", "--get-regexp", "--show-origin", "^url\\..*\\.(insteadOf|pushInsteadOf)$"],
		{ timeoutMs: 5_000 },
	);
	// No matches exit 1 silently; diagnostics and execution failures must stay closed.
	if (rewrites.ok || rewrites.out.trim() !== "" || rewrites.failure || rewrites.err !== "")
		return null;
	const resolved = await gitAsync(
		path,
		["ls-remote", "--get-url", "--end-of-options", configuredUrl],
		{ timeoutMs: 5_000 },
	);
	if (!resolved.ok) return null;
	return safeRepositoryUrl(resolved.out);
}

const storedKeys = ["projectId", "instanceUrl", "remoteProjectId"];
const optionalStoredKeys = [
	"credentialId",
	"httpConsentInstanceUrl",
	"cleanupCredentialIds",
	"scope",
];
function storedRow(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return (
		storedKeys.every((key) => typeof value[key] === "string") &&
		keys.every((key) => [...storedKeys, ...optionalStoredKeys].includes(key)) &&
		(!Object.hasOwn(value, "scope") || value.scope === "group") &&
		(value.credentialId === undefined || typeof value.credentialId === "string") &&
		(value.httpConsentInstanceUrl === undefined ||
			typeof value.httpConsentInstanceUrl === "string") &&
		(value.cleanupCredentialIds === undefined ||
			(Array.isArray(value.cleanupCredentialIds) &&
				value.cleanupCredentialIds.every((id) => typeof id === "string")))
	);
}

// Synchronous read/merge/atomic-replace is one process-local critical section, including
// across adapter instances. Never hold an old loaded snapshot across an await before save.
function persistence(dir: string): IssuesServiceOptions["persistence"] {
	const file = join(dir, "issue-bindings.json");
	function load(): IssueStoredBinding[] {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const rows: unknown = JSON.parse(text);
		if (!Array.isArray(rows) || !rows.every((row) => record(row) && storedRow(row))) invalid();
		return rows as IssueStoredBinding[];
	}
	return {
		async load() {
			return load();
		},
		async save(binding) {
			const rows = load().filter((row) => row.projectId !== binding.projectId);
			// Explicit projection: no input, client or token can enter this file.
			rows.push({
				projectId: binding.projectId,
				instanceUrl: binding.instanceUrl,
				remoteProjectId: binding.remoteProjectId,
				...(binding.scope ? { scope: binding.scope } : {}),
				...(binding.credentialId ? { credentialId: binding.credentialId } : {}),
				...(binding.httpConsentInstanceUrl
					? { httpConsentInstanceUrl: binding.httpConsentInstanceUrl }
					: {}),
				...(binding.cleanupCredentialIds?.length
					? { cleanupCredentialIds: [...binding.cleanupCredentialIds] }
					: {}),
			});
			mkdirSync(dir, { recursive: true });
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, `${JSON.stringify(rows, null, "\t")}\n`, { mode: 0o600 });
				renameSync(temporary, file);
			} finally {
				rmSync(temporary, { force: true });
			}
		},
	};
}

const log = logger("issues");

/** One started implementation as the project group home reads it; `base` stays host-side. */
export interface GroupIssueRecord {
	provider: "gitlab" | "github";
	instanceUrl: string;
	number: number;
	/** The tracker title the host last saw for this Issue (in-memory, since host start). */
	title?: string;
	projectId: string;
	repositories: {
		projectId: string;
		role: "primary" | "associated";
		workspaceId?: string;
		base?: string;
	}[];
}

/** In-memory titles keyed by local project and Issue reference, fed by Issues list/detail reads. */
const TITLE_CACHE_MAX = 2000;
function titleKey(projectId: string, reference: IssueReference): string {
	return JSON.stringify([
		projectId,
		reference.provider,
		reference.instanceUrl,
		reference.projectId,
		reference.number,
	]);
}

/** Host-only composition seam; credentials remain solely inside the issues service. */
export function createIssuesHost(
	options: {
		dir?: string;
		fetch?: IssuesServiceOptions["fetch"];
		sessions?: IssueActionSessions;
		start?: IssueAgentSessionHostOptions["start"];
		/** Tests must inject a disposable store; production uses the host OS vault. */
		credentials?: IssueCredentialStore;
	} = {},
) {
	const root = resolve(options.dir ?? dataDir());
	const credentials =
		options.credentials ?? createIssueCredentials({ namespace: `profile:${root}` });
	let pending: Promise<IssuesService> | undefined;
	function service(): Promise<IssuesService> {
		if (!pending) {
			pending = createIssuesService({
				persistence: persistence(root),
				credentialStore: credentials,
				...(options.fetch ? { fetch: options.fetch } : {}),
			}).catch((error) => {
				pending = undefined;
				throw error;
			});
		}
		return pending;
	}
	async function restore(projectId: string, trusted: boolean): Promise<void> {
		const issues = await service();
		project(projectId, trusted);
		await issues.restore(projectId);
		project(projectId, trusted);
	}
	let store: IssueSessionStore | undefined;
	function issueSessionStore(): IssueSessionStore {
		if (!store) {
			privateDirectory(root);
			const path = join(root, "issue-sessions");
			privateDirectory(path);
			store = createIssueSessionStore(path);
		}
		return store;
	}
	const confirmationPath = join(root, "issue-confirmations");
	const journal = () => {
		privateDirectory(root);
		privateDirectory(confirmationPath);
		return createIssueConfirmationStore(confirmationPath);
	};
	async function confirmationBinding(sessionId: string) {
		const binding = await agentSessionsBinding(sessionId);
		project(binding.projectId, true);
		const ws = getWorkspace(binding.workspaceId);
		if (ws.projectId !== binding.projectId) invalid();
		return binding;
	}
	async function agentSessionsBinding(sessionId: string) {
		const binding = await issueSessionStore().get(sessionId);
		if (!binding) invalid();
		return binding;
	}
	async function trustedCheckout(repository: {
		projectId: string;
		workspaceId: string;
		path: string;
	}) {
		const ws = getWorkspace(repository.workspaceId);
		if (ws.projectId !== repository.projectId || ws.worktreePath !== repository.path) invalid();
		project(repository.projectId, true);
		const [head, tree, branch, status] = await Promise.all([
			gitAsync(repository.path, ["rev-parse", "HEAD"]),
			gitAsync(repository.path, ["rev-parse", "HEAD^{tree}"]),
			gitAsync(repository.path, ["symbolic-ref", "--short", "HEAD"]),
			gitAsync(repository.path, ["status", "--porcelain"]),
		]);
		if (!head.ok || !tree.ok || !branch.ok || !status.ok) invalid();
		return { sha: head.out, tree: tree.out, branch: branch.out, dirty: status.out !== "" };
	}
	async function participatingRepositories(binding: IssueSessionAssociation) {
		const contexts = await actions.implementationContexts({
			projectId: binding.projectId,
			reference: binding.reference,
		});
		return contexts.flatMap((repository) =>
			repository.role === "reference" ? [] : [{ ...repository, role: repository.role }],
		);
	}
	type DirectVerification = (
		sessionId: string,
		payload: { sessionId: string; operationId: string },
		toolCallId: string,
	) => Promise<void>;
	function stages(verifyDirect?: DirectVerification, store = journal()) {
		return createIssueStageActions({
			binding: confirmationBinding,
			journal: store,
			access: async (binding) => {
				await restore(binding.projectId, true);
				const issues = await service();
				const remote = issues.deliveryFor(binding.projectId, binding.reference);
				return {
					remote,
					guard: () => {
						project(binding.projectId, true);
						if (issues.deliveryFor(binding.projectId, binding.reference) !== remote) invalid();
					},
				};
			},
			repositories: participatingRepositories,
			checkout: trustedCheckout,
			verifyAnswer:
				verifyDirect ??
				(async (sessionId, payload, toolCallId) => {
					const binding = await confirmationBinding(sessionId);
					const ws = getWorkspace(binding.workspaceId);
					const { messages } = await getSessionMessages(
						sessionId,
						binding.workspaceId,
						ws.worktreePath,
					);
					if (!isTrustedQuestionnaireReceipt(messages, toolCallId, stageQuestions(payload)))
						invalidReceipt();
				}),
		});
	}
	function bodies(verifyDirect?: DirectVerification, store = journal()) {
		return createIssueBodyActions({
			binding: confirmationBinding,
			journal: store,
			access: async (binding) => {
				await restore(binding.projectId, true);
				const issues = await service();
				const remote = issues.deliveryFor(binding.projectId, binding.reference);
				return {
					remote,
					guard: () => {
						project(binding.projectId, true);
						if (issues.deliveryFor(binding.projectId, binding.reference) !== remote) invalid();
					},
				};
			},
			verifyAnswer:
				verifyDirect ??
				(async (sessionId, payload, toolCallId) => {
					const binding = await confirmationBinding(sessionId);
					const ws = getWorkspace(binding.workspaceId);
					const { messages } = await getSessionMessages(
						sessionId,
						binding.workspaceId,
						ws.worktreePath,
					);
					if (!isTrustedQuestionnaireReceipt(messages, toolCallId, issueBodyQuestions(payload)))
						invalidReceipt();
				}),
		});
	}
	function closes(
		authorize?: (
			sessionId: string,
			payload: IssueClosePayload,
			authorization: unknown,
		) => Promise<void>,
		verifyDirect?: DirectVerification,
		store = journal(),
	) {
		return createIssueCloseActions({
			binding: confirmationBinding,
			journal: store,
			access: async (binding) => {
				await restore(binding.projectId, true);
				const issues = await service();
				const remote = issues.deliveryFor(binding.projectId, binding.reference);
				return {
					remote,
					guard: () => {
						project(binding.projectId, true);
						if (issues.deliveryFor(binding.projectId, binding.reference) !== remote) invalid();
					},
				};
			},
			...(authorize ? { authorize } : {}),
			verifyAnswer:
				verifyDirect ??
				(async (sessionId, payload, toolCallId) => {
					const binding = await confirmationBinding(sessionId);
					const ws = getWorkspace(binding.workspaceId);
					const { messages } = await getSessionMessages(
						sessionId,
						binding.workspaceId,
						ws.worktreePath,
					);
					if (!isTrustedQuestionnaireReceipt(messages, toolCallId, issueCloseQuestions(payload)))
						invalidReceipt();
				}),
		});
	}
	function deliveryStateActions() {
		const path = join(root, "issue-delivery-state");
		privateDirectory(root);
		privateDirectory(path);
		return createIssueDeliveryStateActions({
			binding: confirmationBinding,
			repositories: participatingRepositories,
			checkout: trustedCheckout,
			mergeRequest: async (binding, projectId, iid) => {
				const access = await repositoryAccess(binding, projectId);
				const metadata = await access.remote.project();
				const request = await access.remote.mergeRequest(iid);
				access.guard();
				if (request.targetProjectId !== metadata.id || request.sourceProjectId !== metadata.id)
					invalid();
				if (!request.sha) invalid();
				return { ...request, headSha: request.sha };
			},
			store: createIssueDeliveryStatePersistence(path),
		});
	}
	async function repositoryAccess(binding: IssueSessionAssociation, repositoryProjectId: string) {
		project(binding.projectId, true);
		const repositoryProject = project(repositoryProjectId, true);
		await restore(repositoryProjectId, true);
		const issues = await service();
		const connection = issues.connection(repositoryProjectId);
		if (!connection?.connected) invalid();
		const provider = issueProviderForInstanceUrl(connection.instanceUrl);
		if (!provider) invalid();
		const remote = issues.deliveryFor(repositoryProjectId, {
			provider,
			instanceUrl: connection.instanceUrl,
			projectId: connection.remoteProjectId,
			number: binding.reference.number,
		});
		return {
			remote,
			guard: () => {
				project(binding.projectId, true);
				if (project(repositoryProjectId, true).path !== repositoryProject.path) invalid();
				if (
					issues.deliveryFor(repositoryProjectId, {
						provider,
						instanceUrl: connection.instanceUrl,
						projectId: connection.remoteProjectId,
						number: binding.reference.number,
					}) !== remote
				)
					invalid();
			},
		};
	}
	function mergeRequests(
		authorize?: (
			sessionId: string,
			payload: MergeRequestPayload,
			authorization: unknown,
		) => Promise<void>,
		verifyDirect?: DirectVerification,
		store = journal(),
	) {
		return createIssueMergeRequestActions({
			binding: confirmationBinding,
			journal: store,
			repositories: participatingRepositories,
			access: repositoryAccess,
			...(authorize ? { authorize } : {}),
			verifyAnswer:
				verifyDirect ??
				(async (sessionId, payload, toolCallId) => {
					const binding = await confirmationBinding(sessionId);
					const ws = getWorkspace(binding.workspaceId);
					const { messages } = await getSessionMessages(
						sessionId,
						binding.workspaceId,
						ws.worktreePath,
					);
					if (!isTrustedQuestionnaireReceipt(messages, toolCallId, mergeRequestQuestions(payload)))
						invalidReceipt();
				}),
		});
	}
	function deliveries(
		authorize?: (
			sessionId: string,
			payload: DeliveryPayload,
			authorization: unknown,
		) => Promise<void>,
		verifyDirect?: DirectVerification,
		store = journal(),
	) {
		return createIssueDeliveryActions({
			binding: confirmationBinding,
			journal: store,
			checkout: trustedCheckout,
			repositories: participatingRepositories,
			access: async (binding) => {
				await restore(binding.projectId, true);
				const issues = await service();
				const remote = issues.deliveryFor(binding.projectId, binding.reference);
				return {
					remote,
					guard: () => {
						project(binding.projectId, true);
						if (issues.deliveryFor(binding.projectId, binding.reference) !== remote) invalid();
					},
				};
			},
			repositoryRemote: async (repository) => {
				await restore(repository.projectId, true);
				const issues = await service();
				const connection = issues.connection(repository.projectId);
				if (!connection?.connected) invalid();
				const provider = issueProviderForInstanceUrl(connection.instanceUrl);
				if (!provider) invalid();
				const remote = issues.deliveryFor(repository.projectId, {
					provider,
					instanceUrl: connection.instanceUrl,
					projectId: connection.remoteProjectId,
					number: 1,
				});
				const metadata = await remote.project();
				const urls = await originUrls(repository.path);
				const configuredPushUrl = urls.push;
				const expectedUrl = safeRepositoryUrl(metadata.httpUrlToRepo ?? null);
				if (
					!metadata.defaultBranch ||
					!expectedUrl ||
					!configuredPushUrl ||
					safeRepositoryUrl(configuredPushUrl) !== expectedUrl ||
					(await deliveryPushUrl(repository.path, configuredPushUrl)) !== expectedUrl
				)
					invalid();
				return {
					remote,
					repositoryId: String(metadata.id),
					url: expectedUrl,
					targetBranch: metadata.defaultBranch,
				};
			},
			remoteBranchSha: async (repository, input) => {
				project(repository.projectId, true);
				const urls = await originUrls(repository.path);
				const effective = urls.push ? await deliveryPushUrl(repository.path, urls.push) : null;
				if (!effective || effective !== safeRepositoryUrl(input.url)) invalid();
				return readPushBranchSha(repository.path, input.branch, effective);
			},
			push: async (repository, input, onDispatch) => {
				const current = await trustedCheckout(repository);
				if (current.sha !== input.sha || current.branch !== input.branch) invalid();
				// Recheck immediately before dispatch: URL config may have changed since review.
				const urls = await originUrls(repository.path);
				const effective = urls.push ? await deliveryPushUrl(repository.path, urls.push) : null;
				if (!effective || effective !== safeRepositoryUrl(input.url)) invalid();
				if (
					input.pushMode !== undefined &&
					(input.pushMode !== "force-with-lease" ||
						!input.expectedRemoteSha ||
						!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.expectedRemoteSha))
				)
					invalid();
				onDispatch();
				const pushed = await gitAsync(repository.path, [
					"-c",
					"push.followTags=false",
					"push",
					...(input.pushMode
						? [`--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteSha}`]
						: []),
					"--",
					effective,
					`${input.sha}:refs/heads/${input.branch}`,
				]);
				if (!pushed.ok)
					throw new CodedError("RESOURCE_UNAVAILABLE", "Issue push requires reconciliation.");
			},
			...(authorize ? { authorize } : {}),
			verifyAnswer:
				verifyDirect ??
				(async (sessionId, payload, toolCallId) => {
					const binding = await confirmationBinding(sessionId);
					const ws = getWorkspace(binding.workspaceId);
					const { messages } = await getSessionMessages(
						sessionId,
						binding.workspaceId,
						ws.worktreePath,
					);
					if (!isTrustedQuestionnaireReceipt(messages, toolCallId, deliveryQuestions(payload)))
						invalidReceipt();
				}),
		});
	}
	async function repositoryDependencyGate(sessionId: string) {
		const binding = await confirmationBinding(sessionId);
		const contexts = await participatingRepositories(binding);
		const state = await deliveryStateActions().read(sessionId);
		const missing = contexts.filter(
			(item) => !state.repositories.some((saved) => saved.projectId === item.projectId),
		);
		const extra = state.repositories.filter(
			(saved) => !contexts.some((item) => item.projectId === saved.projectId),
		);
		if (missing.length || extra.length)
			throw new CodedError(
				"ISSUE_DELIVERY_REFUSED",
				`Repository dependency preflight refused (delivery-state-incomplete); revision=${state.revision}; missing=${JSON.stringify(missing.map((item) => item.projectId))}; extra=${JSON.stringify(extra.map((item) => item.projectId))}. Read delivery state and register every participating repository using its observed checkout and the current revision. Extra repositories require reconciliation; do not erase history.`,
			);
		const repositories: IssueDependencyRepository[] = await Promise.all(
			state.repositories.map(async (saved) => {
				const context = contexts.find((item) => item.projectId === saved.projectId);
				if (!context) invalid();
				const access = await repositoryAccess(binding, saved.projectId);
				const issues = await service();
				const connection = issues.connection(saved.projectId);
				if (!connection?.connected) invalid();
				const provider = issueProviderForInstanceUrl(connection.instanceUrl);
				const metadata = await access.remote.project();
				access.guard();
				if (!provider || provider !== access.remote.provider) invalid();
				return {
					projectId: saved.projectId,
					provider,
					instanceUrl: connection.instanceUrl,
					remoteProjectId: metadata.id,
					targetBranch: saved.targetBranch,
					...(saved.mergeRequest ? { mergeRequestIid: saved.mergeRequest.iid } : {}),
					dependsOn: [...saved.dependsOn],
				};
			}),
		);
		return createIssueRepositoryDependencies({
			repositories,
			remoteFor: async (repository) => {
				const issues = await service();
				const connection = issues.connection(repository.projectId);
				if (
					!connection?.connected ||
					connection.instanceUrl !== repository.instanceUrl ||
					issueProviderForInstanceUrl(connection.instanceUrl) !== repository.provider ||
					String(connection.remoteProjectId) !== String(repository.remoteProjectId)
				)
					invalid();
				const access = await repositoryAccess(binding, repository.projectId);
				const remote = access.remote;
				if (remote.provider !== repository.provider) invalid();
				const metadata = await remote.project();
				access.guard();
				if (metadata.id !== repository.remoteProjectId) invalid();
				return {
					provider: remote.provider,
					instanceUrl: repository.instanceUrl,
					remote: {
						project: async () => {
							const value = await remote.project();
							access.guard();
							return value;
						},
						mergeRequest: async (iid) => {
							const value = await remote.mergeRequest(iid);
							access.guard();
							return value;
						},
						targetBranchSha: async (branch) => {
							const value = await remote.targetBranchSha(branch);
							access.guard();
							return value;
						},
						...(remote.mergeEvidence
							? {
									mergeEvidence: async (iid: number) => {
										const value = await remote.mergeEvidence?.(iid);
										access.guard();
										if (!value) invalid();
										return value;
									},
								}
							: {}),
					},
				};
			},
			checkout: async (projectId) => {
				const context = contexts.find((item) => item.projectId === projectId);
				if (!context) invalid();
				const checkout = await trustedCheckout(context);
				return { sha: checkout.sha, tree: checkout.tree };
			},
			compatibility: async (input) => {
				const context = contexts.find((item) => item.projectId === input.projectId);
				if (!context) invalid();
				const before = await trustedCheckout(context);
				if (
					before.dirty ||
					before.sha !== input.downstreamSha ||
					before.tree !== input.downstreamTree
				)
					throw new CodedError(
						"ISSUE_DELIVERY_REFUSED",
						"Repository compatibility refused (checkout-changed-or-dirty).",
					);
				const evidence = await runIssueCompatibility({ ...input, path: context.path });
				const after = await trustedCheckout(context);
				if (after.dirty || after.sha !== before.sha || after.tree !== before.tree)
					throw new CodedError(
						"ISSUE_DELIVERY_REFUSED",
						"Repository compatibility refused (checkout-changed-or-dirty).",
					);
				return evidence;
			},
		});
	}
	function automationActions() {
		let authorize: (sessionId: string, payload: unknown, token: unknown) => Promise<void> =
			async () => invalid();
		async function selectedRepository(
			sessionId: string,
			policyRepository: IssueAutomationPolicy["repository"],
		) {
			const binding = await confirmationBinding(sessionId);
			const repository = (await participatingRepositories(binding)).find(
				(item) => item.projectId === policyRepository.projectId,
			);
			if (!repository || repository.workspaceId !== policyRepository.workspaceId) invalid();
			return { binding, repository };
		}
		const actions = createIssueAutomationActions({
			journal: journal(),
			binding: confirmationBinding,
			repositories: async ({ sessionId }) => {
				const binding = await confirmationBinding(sessionId);
				const contexts = await participatingRepositories(binding);
				const state = await deliveryStateActions().read(sessionId);
				return Promise.all(
					contexts.map(async (repository) => {
						const saved = state.repositories.find(
							(entry) => entry.projectId === repository.projectId,
						);
						const access = await repositoryAccess(binding, repository.projectId);
						const metadata = await access.remote.project();
						access.guard();
						const checkout = await trustedCheckout(repository);
						return {
							projectId: repository.projectId,
							workspaceId: repository.workspaceId,
							sourceBranch: checkout.branch,
							targetBranch: saved?.targetBranch ?? "",
							repositoryId: String(metadata.id),
						};
					}),
				);
			},
			verifyAnswer: async (sessionId, payload, toolCallId) => {
				const binding = await confirmationBinding(sessionId);
				const ws = getWorkspace(binding.workspaceId);
				const { messages } = await getSessionMessages(
					sessionId,
					binding.workspaceId,
					ws.worktreePath,
				);
				if (!isTrustedQuestionnaireReceipt(messages, toolCallId, policyQuestions(payload)))
					invalidReceipt();
			},
			checkout: async (sessionId, policyRepository) => {
				const { repository } = await selectedRepository(sessionId, policyRepository);
				const checkout = await trustedCheckout(repository);
				return { sha: checkout.sha, branch: checkout.branch };
			},
			isAncestor: async (sessionId, policyRepository, ancestor, descendant) => {
				const { repository } = await selectedRepository(sessionId, policyRepository);
				return (
					await gitAsync(repository.path, ["merge-base", "--is-ancestor", ancestor, descendant])
				).ok;
			},
			delivery: {
				prepare: (sessionId, input) => deliveries().prepare(sessionId, input),
				execute: (sessionId, operationId, toolCallId, authorization) =>
					deliveries(authorize).execute(sessionId, operationId, toolCallId, authorization),
			},
			mergeRequest: {
				prepare: (sessionId, action, input) => mergeRequests().prepare(sessionId, action, input),
				execute: (sessionId, operationId, toolCallId, authorization) =>
					mergeRequests(authorize).execute(sessionId, operationId, toolCallId, authorization),
			},
			close: {
				prepare: (sessionId, input) => closes().prepare(sessionId, input),
				execute: (sessionId, operationId, toolCallId, authorization) =>
					closes(authorize).execute(sessionId, operationId, toolCallId, authorization),
			},
			request: async (sessionId, projectId, iid) => {
				const binding = await confirmationBinding(sessionId);
				const access = await repositoryAccess(binding, projectId);
				const request = await access.remote.mergeRequest(iid);
				access.guard();
				return request;
			},
			readiness: async (sessionId, projectId, iid, sha) => {
				const binding = await confirmationBinding(sessionId);
				const access = await repositoryAccess(binding, projectId);
				const facts = access.remote.mergeReadiness
					? await access.remote.mergeReadiness(iid, sha)
					: null;
				access.guard();
				return facts?.expectedSha === sha && facts.actualSha === sha
					? { checks: facts.checks, approval: facts.approval }
					: { checks: "unknown", approval: "unknown" };
			},
			deliveryState: (sessionId) => deliveryStateActions().read(sessionId),
			dependencyPreflight: async (sessionId, projectId) =>
				(await repositoryDependencyGate(sessionId)).preflight(projectId),
			observeMerged: async (sessionId, policy, iid) => {
				const { binding } = await selectedRepository(sessionId, policy.repository);
				const access = await repositoryAccess(binding, policy.repository.projectId);
				if (!access.remote.mergeEvidence) return false;
				const [project, request, evidence] = await Promise.all([
					access.remote.project(),
					access.remote.mergeRequest(iid),
					access.remote.mergeEvidence(iid),
				]);
				access.guard();
				const targetSha = await access.remote.targetBranchSha(policy.repository.targetBranch);
				access.guard();
				return (
					request.state === "merged" &&
					request.sourceBranch === policy.repository.sourceBranch &&
					request.targetBranch === policy.repository.targetBranch &&
					request.sourceProjectId === project.id &&
					request.targetProjectId === project.id &&
					evidence.iid === iid &&
					evidence.relationship === "ancestor" &&
					evidence.targetBranch === policy.repository.targetBranch &&
					evidence.mergeCommitSha === request.mergeCommitSha &&
					evidence.targetSha === targetSha
				);
			},
		});
		authorize = actions.authorizeChild;
		return actions;
	}
	type ConfirmationPayload =
		| DeliveryPayload
		| StagePayload
		| IssueBodyPayload
		| IssueClosePayload
		| MergeRequestPayload
		| IssueAutomationPolicy;
	function questionsFor(payload: ConfirmationPayload) {
		if (payload.stage === "issue-automation-policy") return policyQuestions(payload);
		if (payload.stage === "ready-mr" || payload.stage === "merge-mr")
			return mergeRequestQuestions(payload);
		if (payload.stage === "delivery") return deliveryQuestions(payload);
		if (payload.stage === "update-body") return issueBodyQuestions(payload);
		if (payload.stage === "close-issue") return issueCloseQuestions(payload);
		if (payload.stage === "design" || payload.stage === "implementation")
			return stageQuestions(payload);
		invalid();
	}
	function observeOperation(sessionId: string, payload: ConfirmationPayload) {
		if (payload.stage === "ready-mr" || payload.stage === "merge-mr")
			return mergeRequests().observe(sessionId, payload);
		if (payload.stage === "delivery") return deliveries().observe(sessionId, payload);
		if (payload.stage === "update-body") return bodies().observe(sessionId, payload);
		if (payload.stage === "close-issue") return closes().observe(sessionId, payload);
		if (payload.stage === "design" || payload.stage === "implementation")
			return stages().observe(sessionId, payload);
		invalid();
	}
	function recoveryQuestions(operationId: string, candidateDigest: string, candidate: unknown) {
		return {
			questions: [
				{
					question:
						"Has the original operation/process ended, and do you approve adopting this observed remote result without resending?",
					header: "Reconcile",
					preview: `Operation: ${operationId}\nRecovery version: ${candidateDigest}\n${JSON.stringify(candidate, null, 2)}\n\nThis only records the observed remote receipt for the original operation and releases its uncertainty fence. Exact matching content does not prove original authorship; you are approving adoption of this observed result. It sends no push, note, label update or PR/MR creation. Confirm that the original request/process has ended before approving.`,
					options: [
						{
							label: "Looks right",
							description:
								"The original process ended; adopt this exact observed result without another remote write.",
						},
					],
				},
			],
		};
	}
	const continuations = createIssueContinuations({
		verify: async (sessionId, toolCallId, questions) => {
			const binding = await confirmationBinding(sessionId);
			const ws = getWorkspace(binding.workspaceId);
			const { messages } = await getSessionMessages(
				sessionId,
				binding.workspaceId,
				ws.worktreePath,
			);
			if (!isTrustedQuestionnaireReceipt(messages, toolCallId, questions)) invalidReceipt();
		},
	});
	async function prepareConfirmation(
		sessionId: string,
		params: Parameters<NonNullable<IssueAgentSessionHostOptions["prepareConfirmation"]>>[1],
		direct = false,
	) {
		const request = structuredClone(params);
		const store = journal();
		if (direct) {
			const prepare = store.prepare;
			store.prepare = (id, operationId, payload) => {
				if (!record(payload)) invalid();
				return prepare(id, operationId, { ...payload, directRequest: request });
			};
		}
		if (
			request.pushMode !== undefined &&
			(request.pushMode !== "force-with-lease" ||
				!request.projectId ||
				request.action ||
				request.inspect ||
				request.recovery ||
				request.report)
		)
			invalid();
		if (request.action === "read-delivery-state") {
			if (
				request.inspect ||
				request.continueDespiteChecks ||
				request.recovery ||
				request.report ||
				request.projectId ||
				request.title ||
				request.body !== undefined ||
				request.targetBranch ||
				request.deliveryState !== undefined ||
				request.expectedRevision !== undefined
			)
				invalid();
			await confirmationBinding(sessionId);
			return deliveryStateActions().read(sessionId);
		}
		if (request.action === "record-delivery-state") {
			if (
				request.inspect ||
				request.continueDespiteChecks ||
				request.recovery ||
				request.report ||
				request.projectId ||
				request.title ||
				request.body !== undefined ||
				request.targetBranch ||
				!Number.isSafeInteger(request.expectedRevision) ||
				request.deliveryState === undefined
			)
				invalid();
			await confirmationBinding(sessionId);
			return deliveryStateActions().record(
				sessionId,
				request.expectedRevision as number,
				request.deliveryState,
			);
		}
		if (request.action === "preflight-dependencies") {
			if (!exact(request, ["operationId", "action", "projectId"]) || !request.projectId) invalid();
			await confirmationBinding(sessionId);
			try {
				const receipt = await (await repositoryDependencyGate(sessionId)).preflight(
					request.projectId,
				);
				return { status: "passed", operationId: request.operationId, receipt };
			} catch (error) {
				if (!(error instanceof CodedError) || error.code !== "ISSUE_DELIVERY_REFUSED") throw error;
				return {
					status: "blocked",
					operationId: request.operationId,
					reason: error.message,
					nextAction:
						"Do not update downstream pairing. For delivery-state-incomplete, read-delivery-state then record-delivery-state with every participating repository and expectedRevision. For missing-upstream-request, register its mergeRequestId for provider verification. For compatibility configuration errors, configure .thinkrail/issue-compatibility.json in the trusted downstream worktree. Other refusals require resolving the named mismatch; a link or independent CI is not compatibility evidence.",
				};
			}
		}
		if (request.action === "advance-automation") {
			if (!exact(request, ["operationId", "action", "projectId"]) || !request.projectId) invalid();
			await confirmationBinding(sessionId);
			return automationActions().advance(sessionId, request.operationId, request.projectId);
		}
		const run: typeof continuations.run = direct
			? async (_sessionId, _operationId, _phase, _snapshot, attempt) => attempt(false)
			: continuations.run;
		return run(sessionId, request.operationId, "prepare", request, async (continued) => {
			const input = {
				...request,
				...(continued && !request.inspect && !request.recovery
					? { continueDespiteChecks: true }
					: {}),
			};
			if (input.recovery === "reconcile") {
				if (
					input.continueDespiteChecks ||
					input.action ||
					input.workflowTarget !== undefined ||
					input.normalizeWorkflowLabel !== undefined
				)
					invalid();
				if (
					input.inspect ||
					input.report ||
					input.projectId ||
					input.title ||
					input.body !== undefined ||
					input.targetBranch ||
					input.continueDespiteChecks ||
					input.workflowTarget !== undefined ||
					input.normalizeWorkflowLabel !== undefined
				)
					invalid();
				await confirmationBinding(sessionId);
				const store = journal();
				const state = await store.inspect(sessionId, input.operationId);
				if (state.status !== "uncertain") return state;
				const payload = state.payload as ConfirmationPayload;
				const observed = await observeOperation(sessionId, payload);
				const frozen = await store.prepareRecovery(sessionId, input.operationId, observed);
				return {
					status: "recovery-prepared",
					...frozen,
					questions: recoveryQuestions(input.operationId, frozen.candidateDigest, observed),
				};
			}
			if (input.inspect) {
				if (input.action) invalid();
				if (
					input.report ||
					input.projectId ||
					input.title ||
					input.body !== undefined ||
					input.targetBranch ||
					input.continueDespiteChecks
				)
					invalid();
				await confirmationBinding(sessionId);
				let state: IssueConfirmationInspection | undefined;
				try {
					state = await journal().inspect?.(sessionId, input.operationId);
				} catch (error) {
					if (error instanceof CodedError && error.code === "ISSUE_CONFIRMATION_BLOCKED")
						return {
							status: "blocked",
							reason: error.message,
							nextAction: "Resolve the journal cause shown above, then inspect again.",
						};
					throw error;
				}
				if (!state) invalid();
				if (state.status === "missing") return state;
				let questions: ReturnType<typeof stageQuestions> | undefined;
				try {
					const payload = state.payload as ConfirmationPayload;
					if (
						payload?.stage === "delivery" ||
						payload?.stage === "design" ||
						payload?.stage === "implementation" ||
						payload?.stage === "update-body" ||
						payload?.stage === "close-issue" ||
						payload?.stage === "merge-mr" ||
						payload?.stage === "issue-automation-policy"
					)
						questions = questionsFor(payload);
				} catch {
					questions = undefined;
				}
				return {
					status: state.status,
					digest: state.digest,
					...(questions ? { questions } : {}),
					...(state.status === "completed" ? { result: state.result } : {}),
					...(state.failure ? { failure: state.failure } : {}),
					nextAction: !questions
						? "The frozen payload cannot be displayed. Preserve this operation and inspect its local application schema before continuing."
						: state.status === "prepared"
							? "This operation has no mutation intent. Use its frozen card, or prepare a distinct newly reviewed operation for changed content."
							: state.status === "completed"
								? "Return this receipt. For a later CI repair, prepare a new delivery operation targeting the same PR/MR."
								: "A mutation may have been sent. Read the remote PR/MR or note first; do not resend or use another ID to bypass this intent.",
				};
			}
			if (input.action === "authorize-automation") {
				const keys = [
					"operationId",
					"action",
					"projectId",
					"title",
					"body",
					"mode",
					"closeIssue",
					...(input.closeIssue === true ? ["reason", "acceptance"] : []),
				];
				if (
					!exact(input, keys) ||
					!input.projectId ||
					typeof input.title !== "string" ||
					typeof input.body !== "string" ||
					!["draft", "auto-merge", "manual"].includes(String(input.mode)) ||
					typeof input.closeIssue !== "boolean" ||
					(input.closeIssue && (!input.reason || !input.acceptance))
				)
					invalid();
				return automationActions().prepare(sessionId, {
					operationId: input.operationId,
					projectId: input.projectId,
					title: input.title,
					body: input.body,
					mode: input.mode as IssueAutomationPolicy["mode"],
					closeIssue: input.closeIssue,
					reason: input.reason ?? "",
					acceptance: input.acceptance ?? "",
				});
			}
			if (input.action === "ready-mr" || input.action === "merge-mr") {
				if (
					input.report ||
					!input.projectId ||
					!Number.isSafeInteger(input.mergeRequestId) ||
					!input.targetBranch ||
					!input.expectedSha ||
					input.body !== undefined ||
					input.title ||
					input.deliveryState !== undefined ||
					input.expectedRevision !== undefined ||
					input.continueDespiteChecks ||
					input.workflowTarget !== undefined ||
					input.normalizeWorkflowLabel !== undefined
				)
					invalid();
				return mergeRequests(undefined, undefined, store).prepare(sessionId, input.action, {
					operationId: input.operationId,
					projectId: input.projectId,
					iid: input.mergeRequestId as number,
					targetBranch: input.targetBranch,
					expectedSha: input.expectedSha,
				});
			}
			if (input.action === "close-issue") {
				if (!input.reason || !input.acceptance)
					invalid("Issue close requires non-empty reason and acceptance fields.");
				if (
					input.body !== undefined ||
					input.projectId ||
					input.title ||
					input.report ||
					input.targetBranch ||
					input.continueDespiteChecks ||
					input.workflowTarget !== undefined ||
					input.normalizeWorkflowLabel !== undefined
				)
					invalid(
						"Issue close does not accept body, projectId, title, report, targetBranch, or continueDespiteChecks.",
					);
				return closes(undefined, undefined, store).prepare(sessionId, {
					operationId: input.operationId,
					reason: input.reason,
					acceptance: input.acceptance,
				});
			}
			if (input.action === "update-body") {
				if (
					input.body === undefined ||
					input.projectId ||
					input.title ||
					input.report ||
					input.targetBranch ||
					input.continueDespiteChecks ||
					input.workflowTarget !== undefined ||
					input.normalizeWorkflowLabel !== undefined
				)
					invalid();
				return bodies(undefined, store).prepare(sessionId, {
					operationId: input.operationId,
					body: input.body,
				});
			}
			if (input.projectId) {
				if (
					!input.title ||
					input.body === undefined ||
					input.report ||
					input.workflowTarget !== undefined ||
					input.normalizeWorkflowLabel !== undefined
				)
					invalid();
				try {
					return await deliveries(undefined, undefined, store).prepare(sessionId, {
						operationId: input.operationId,
						projectId: input.projectId,
						title: input.title,
						body: input.body,
						...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
						...(input.pushMode ? { pushMode: input.pushMode } : {}),
						...(input.continueDespiteChecks ? { continueDespiteChecks: true } : {}),
					});
				} catch (error) {
					if (!direct && error instanceof CodedError && error.code === "ISSUE_DELIVERY_REFUSED")
						return {
							status: "blocked",
							reason: error.message,
							canContinue: error.message.includes("[issue-not-open]"),
							nextAction: error.message.includes("[issue-not-open]")
								? "Prepare with continueDespiteChecks:true to obtain a one-shot warned card."
								: "Correct the invalid or unavailable execution prerequisite described above, then prepare a fresh exact card. This condition is not made valid by a policy override.",
						};
					throw error;
				}
			}
			if (
				!input.report ||
				input.title ||
				input.body ||
				input.targetBranch ||
				(input.normalizeWorkflowLabel !== undefined &&
					typeof input.normalizeWorkflowLabel !== "boolean")
			)
				invalid();
			try {
				return await stages(undefined, store).prepare(sessionId, {
					operationId: input.operationId,
					report: input.report,
					...(input.workflowTarget ? { workflowTarget: input.workflowTarget } : {}),
					...(input.normalizeWorkflowLabel ? { normalizeWorkflowLabel: true } : {}),
					...(input.continueDespiteChecks ? { continueDespiteChecks: true } : {}),
				});
			} catch (error) {
				if (!direct && error instanceof CodedError && error.code === "ISSUE_CONFIRMATION_BLOCKED")
					return {
						status: "blocked",
						reason: error.message,
						canContinue: error.message.includes("Retry with continueDespiteChecks:true"),
						nextAction: error.message.includes("Retry with continueDespiteChecks:true")
							? "Prepare with continueDespiteChecks:true for a one-shot warned card if you choose to accept the displayed policy exception."
							: "Inspect the original operation and current facts, then prepare a refreshed card if no intent is uncertain.",
					};
				throw error;
			}
		});
	}
	const agentSessions = createIssueAgentSessionHost({
		service,
		prepareConfirmation,
		runOperation: async (sessionId, params) => {
			// Only this bound invocation grants authority; no caller flag or receipt does.
			const request = JSON.parse(JSON.stringify(params)) as typeof params;
			if (request.recovery === "reconcile") {
				if (request.inspect !== undefined || request.action !== undefined) invalid();
				await confirmationBinding(sessionId);
				return reconcileDirectOperation({
					sessionId,
					operationId: request.operationId,
					store: journal(),
					observe: async (payload) => {
						if (!record(payload) || typeof payload.stage !== "string") invalid();
						switch (payload.stage) {
							case "ready-mr":
							case "merge-mr":
								return mergeRequests().observe(
									sessionId,
									payload as unknown as MergeRequestPayload,
								);
							case "delivery":
								return deliveries().observe(sessionId, payload as unknown as DeliveryPayload);
							case "update-body":
								return bodies().observe(sessionId, payload as unknown as IssueBodyPayload);
							case "close-issue":
								return closes().observe(sessionId, payload as unknown as IssueClosePayload);
							case "design":
							case "implementation":
								return stages().observe(sessionId, payload as unknown as StagePayload);
							default:
								return invalid();
						}
					},
				});
			}
			if (
				request.inspect !== undefined ||
				(request.recovery !== undefined && request.recovery !== "reconcile") ||
				(request.action !== undefined &&
					!["update-body", "close-issue", "ready-mr", "merge-mr"].includes(request.action))
			)
				invalid();
			await confirmationBinding(sessionId);
			const store = journal();
			const prior = await store.inspect(sessionId, request.operationId);
			if (prior.status !== "completed" && (await store.getRecovery(sessionId, request.operationId)))
				invalid();
			if (prior.status !== "missing") {
				if (!record(prior.payload) || !isDeepStrictEqual(prior.payload.directRequest, request))
					throw new CodedError(
						"ISSUE_CONFIRMATION_BLOCKED",
						"Issue confirmation blocked (payload_changed). This operation ID is frozen to its original direct request.",
					);
				if (prior.status === "uncertain")
					throw new CodedError(
						"ISSUE_CONFIRMATION_BLOCKED",
						"Issue confirmation blocked (uncertain_intent). Inspect and reconcile the original operation; it will not be resent.",
					);
				if (prior.status === "completed") return prior.result;
			}
			const prepared =
				prior.status === "prepared"
					? prior
					: await prepareConfirmation(sessionId, request, true).catch((error: unknown) => {
							if (
								error instanceof CodedError &&
								["ISSUE_CONFIRMATION_BLOCKED", "ISSUE_DELIVERY_REFUSED"].includes(error.code)
							)
								throw new CodedError(
									error.code,
									"Direct Issue operation refused. Inspect the original operation and resolve its prerequisites; never resend an uncertain intent.",
								);
							throw error;
						});
			if (!record(prepared) || typeof prepared.digest !== "string") {
				if (!record(prepared)) return prepared;
				const { questions: _questions, ...result } = prepared;
				return result;
			}
			const frozen = await store.get(sessionId, request.operationId);
			if (!frozen || frozen.digest !== prepared.digest) invalid();
			const token = `issue-direct:${createHash("sha256")
				.update(JSON.stringify([sessionId, request.operationId, frozen.digest]))
				.digest("hex")}`;
			const verifyDirect: DirectVerification = async (id, payload, callId) => {
				if (
					id !== sessionId ||
					payload.sessionId !== sessionId ||
					payload.operationId !== request.operationId ||
					callId !== token ||
					!isDeepStrictEqual(payload, frozen.payload)
				)
					invalidReceipt();
				await confirmationBinding(sessionId);
				if (await store.getRecovery(sessionId, request.operationId)) invalid();
			};
			const stage = (frozen.payload as { stage: string }).stage;
			return stage === "ready-mr" || stage === "merge-mr"
				? mergeRequests(undefined, verifyDirect).execute(sessionId, request.operationId, token)
				: stage === "delivery"
					? deliveries(undefined, verifyDirect).execute(sessionId, request.operationId, token)
					: stage === "update-body"
						? bodies(verifyDirect).execute(sessionId, request.operationId, token)
						: stage === "close-issue"
							? closes(undefined, verifyDirect).execute(sessionId, request.operationId, token)
							: stage === "design" || stage === "implementation"
								? stages(verifyDirect).execute(sessionId, request.operationId, token)
								: invalid();
		},
		executeConfirmation: async (sessionId, operationId, toolCallId, continuationId) => {
			if (continuationId)
				return continuations.execute(sessionId, operationId, continuationId, toolCallId);
			return continuations.run(sessionId, operationId, "execute", { operationId }, async () => {
				await confirmationBinding(sessionId);
				const store = journal();
				const recovery = await store.getRecovery(sessionId, operationId);
				if (recovery) {
					const originalReceipt = await store.inspect(sessionId, operationId);
					if (originalReceipt.status === "completed") {
						const original = await store.get(sessionId, operationId);
						if (!original) invalid();
						const payload = original.payload as ConfirmationPayload;
						const binding = await confirmationBinding(sessionId);
						const ws = getWorkspace(binding.workspaceId);
						const { messages } = await getSessionMessages(
							sessionId,
							binding.workspaceId,
							ws.worktreePath,
						);
						const originalQuestions = questionsFor(payload);
						if (isTrustedQuestionnaireReceipt(messages, toolCallId, originalQuestions))
							return originalReceipt.result;
					}
					const binding = await confirmationBinding(sessionId);
					const ws = getWorkspace(binding.workspaceId);
					const { messages } = await getSessionMessages(
						sessionId,
						binding.workspaceId,
						ws.worktreePath,
					);
					if (
						!isTrustedQuestionnaireReceipt(
							messages,
							toolCallId,
							recoveryQuestions(operationId, recovery.candidateDigest, recovery.candidate),
						)
					)
						invalid();
					const original = await store.get(sessionId, operationId);
					if (!original) invalid();
					return store.completeRecovery(
						sessionId,
						operationId,
						recovery.candidateDigest,
						toolCallId,
						async () => {
							const payload = original.payload as ConfirmationPayload;
							const actual = await observeOperation(sessionId, payload);
							if (!isDeepStrictEqual(actual, recovery.candidate)) invalid();
						},
					);
				}
				const stored = await store.get(sessionId, operationId);
				if (!stored) invalid();
				const stage = (stored.payload as { stage: string }).stage;
				return stage === "issue-automation-policy"
					? automationActions().execute(sessionId, operationId, toolCallId)
					: stage === "ready-mr" || stage === "merge-mr"
						? mergeRequests().execute(sessionId, operationId, toolCallId)
						: stage === "delivery"
							? deliveries().execute(sessionId, operationId, toolCallId)
							: stage === "update-body"
								? bodies().execute(sessionId, operationId, toolCallId)
								: stage === "close-issue"
									? closes().execute(sessionId, operationId, toolCallId)
									: stage === "design" || stage === "implementation"
										? stages().execute(sessionId, operationId, toolCallId)
										: invalid();
			});
		},
		store: issueSessionStore,
		project: (id) => project(id, true),
		workspace: getWorkspace,
		status: options.sessions?.status ?? sessionReuseStatus,
		start:
			options.start ?? ((id, _workspaceId, _cwd, prompt) => startInitialSessionPrompt(id, prompt)),
		repositories: (target) =>
			target.stage === "design"
				? actions.designContexts({ projectId: target.projectId, reference: target.reference })
				: actions.implementationContexts({
						projectId: target.projectId,
						reference: target.reference,
					}),
		join: (target, repositoryProjectId) =>
			actions.addRepository({
				projectId: target.projectId,
				reference: target.reference,
				repositoryProjectId,
			}),
		locale: () => {
			const locale = getConfig().locale;
			return locale === "system" ? Intl.DateTimeFormat().resolvedOptions().locale : locale;
		},
	});
	const actions = createIssuesActions(service, root, options.sessions, agentSessions);
	const titles = new Map<string, string>();
	function rememberTitle(projectId: string, reference: IssueReference, title: unknown) {
		if (typeof title !== "string" || title === "") return;
		const key = titleKey(projectId, reference);
		titles.delete(key);
		titles.set(key, title);
		if (titles.size > TITLE_CACHE_MAX) {
			const oldest = titles.keys().next().value;
			if (oldest !== undefined) titles.delete(oldest);
		}
	}
	/**
	 * Workspace→Issue bindings for the project rail, derived from owned implementations (the single
	 * source of ownership). Read-only and best effort: no worktree, session or remote access.
	 */
	function workspaceIssueBindings(): Map<string, WorkspaceIssueBinding> {
		const bindings = new Map<string, WorkspaceIssueBinding>();
		for (const row of createIssueWorkspacePersistence(join(root, "issue-workspaces")).list()) {
			const hasAssociations = (row.repositoryProjectIds ?? []).length > 0;
			const base = {
				provider: row.reference.provider,
				instanceUrl: row.reference.instanceUrl,
				number: row.reference.number,
				hasAssociations,
			};
			const implementation = row.implementation;
			if (implementation?.state === "completed" && row.ownerKind !== "group")
				bindings.set(implementation.workspaceId, { ...base, role: "primary" });
			for (const member of row.members ?? [])
				if (member.ownership?.state === "completed")
					bindings.set(member.ownership.workspaceId, { ...base, role: "associated" });
		}
		return bindings;
	}
	/**
	 * Started implementations whose primary is one of `projectIds`, for the project group home:
	 * the primary and every joined repository with its worktree id and recorded start commit.
	 * Read-only and best effort, like the rail bindings.
	 */
	function groupIssueRecords(projectIds: ReadonlySet<string>): GroupIssueRecord[] {
		const issues: GroupIssueRecord[] = [];
		for (const row of createIssueWorkspacePersistence(join(root, "issue-workspaces")).list()) {
			if (!projectIds.has(row.projectId) || !row.implementation) continue;
			const implementation = row.implementation;
			const title = titles.get(titleKey(row.projectId, row.reference));
			issues.push({
				provider: row.reference.provider,
				instanceUrl: row.reference.instanceUrl,
				number: row.reference.number,
				...(title ? { title } : {}),
				projectId: row.projectId,
				repositories: [
					{
						projectId: row.projectId,
						role: "primary",
						...(implementation.state === "completed"
							? { workspaceId: implementation.workspaceId }
							: {}),
					},
					...(row.members ?? [])
						.filter((member) => member.removing !== true)
						.map((member) => ({
							projectId: member.projectId,
							role: "associated" as const,
							...(member.ownership?.state === "completed"
								? { workspaceId: member.ownership.workspaceId }
								: {}),
							...(member.base ? { base: member.base } : {}),
						})),
				],
			});
		}
		return issues.sort((a, b) => a.number - b.number);
	}
	/**
	 * The other source repositories this bound Issue session may edit. Design reads their Default
	 * checkouts, implementation their fixed Issue worktrees; the primary is resolved separately by the
	 * caller. An unbound session, a fenced launch or any reconciliation failure simply yields none.
	 */
	async function sessionRequiresIssueTools(sessionId: string): Promise<boolean> {
		if (!store) return false;
		try {
			const association = await store.get(sessionId);
			if (!association) return false;
			const ws = getWorkspace(association.workspaceId);
			return ws.projectId === association.projectId && ws.kind !== "chat" && ws.kind !== "external";
		} catch {
			return false;
		}
	}
	async function sessionMemberWorkspaces(
		sessionId: string,
	): Promise<{ workspaceId: string; worktreePath: string }[]> {
		if (!store) return [];
		try {
			const association = await store.get(sessionId);
			if (!association) return [];
			const target = { projectId: association.projectId, reference: association.reference };
			const contexts =
				association.stage === "design"
					? await actions.designContexts(target)
					: await actions.implementationContexts(target);
			return contexts
				.filter((context) => context.role === "associated")
				.map((context) => ({ workspaceId: context.workspaceId, worktreePath: context.path }));
		} catch {
			return [];
		}
	}
	return {
		agentSessions,
		sessionRequiresIssueTools,
		sessionMemberWorkspaces,
		workspaceIssueBindings,
		groupIssueRecords,
		...actions,
		async implementationHistory(params: unknown) {
			if (!isIssueTarget(params)) invalid();
			const target = structuredClone(params);
			project(target.projectId, true);
			await restore(target.projectId, false);
			const issues = await service();
			const remote = issues.remoteFor(target.projectId, target.reference);
			const row = createIssueWorkspacePersistence(join(root, "issue-workspaces"))
				.list()
				.find(
					(row) =>
						row.projectId === target.projectId &&
						isDeepStrictEqual(row.reference, target.reference),
				);
			const history = [...(row?.implementationHistory ?? [])];
			if (row?.implementation?.state === "completed") {
				const current = row.implementation;
				let exists = true;
				try {
					getWorkspace(current.workspaceId);
				} catch {
					exists = false;
				}
				if (!exists)
					history.push({
						workspaceId: current.workspaceId,
						worktreePath: current.worktreePath,
						branch: current.branch,
						...(current.session ? { sessionId: current.session.id } : {}),
						archivedAt: 0,
					});
			}
			const entries = await Promise.all(
				history.map(async (entry) => {
					let messages: TranscriptMessage[] | null = null;
					if (entry.sessionId) {
						try {
							messages = await readArchivedSessionTranscript(entry.sessionId, entry.worktreePath);
						} catch {}
					}
					return {
						workspaceId: entry.workspaceId,
						branch: entry.branch,
						archivedAt: entry.archivedAt || null,
						sessionId: entry.sessionId ?? null,
						messages,
					};
				}),
			);
			project(target.projectId, true);
			if (issues.remoteFor(target.projectId, target.reference) !== remote) invalid();
			return { entries };
		},
		async connection(params: unknown) {
			const { projectId } = request(params);
			project(projectId, false);
			// A saved credential restores on its own; stage actions still require project trust.
			await restore(projectId, false);
			return (await service()).connection(projectId);
		},
		async connect(params: unknown) {
			const { projectId, input } = request(params, true);
			if (!getProjects().some((candidate) => candidate.id === projectId)) {
				log.warn("issues connect rejected: unknown project");
				project(projectId, false);
			}
			const owner = project(projectId, false);
			const issues = await service();
			// Reconstruct the write-only input; do not retain the ingress envelope.
			if (!isIssueConnectionInput(input)) invalid();
			if ((owner.kind === "group") !== (input.scope === "group"))
				throw new CodedError(
					"RESOURCE_UNAVAILABLE",
					"Group trackers belong to group contexts; repository trackers belong to repositories.",
				);
			return issues.connect(projectId, {
				instanceUrl: input.instanceUrl,
				projectId: input.projectId,
				...(input.scope ? { scope: input.scope } : {}),
				token: input.token,
				...(input.httpConsent ? { httpConsent: input.httpConsent } : {}),
			});
		},
		async disconnect(params: unknown) {
			const { projectId } = request(params);
			project(projectId, false);
			// Await deletion: success is only reported after credentials are gone.
			await (await service()).disconnect(projectId);
			return { ok: true } as const;
		},
		async detail(params: unknown) {
			const { projectId, reference } = designTarget(params);
			project(projectId, false);
			await restore(projectId, false);
			const detail = await (await service()).detail(projectId, reference);
			rememberTitle(projectId, detail.reference, detail.title);
			return detail;
		},
		async list(params: unknown) {
			const { projectId } = request(params);
			project(projectId, false);
			await restore(projectId, false);
			const list = await (await service()).list(projectId);
			for (const issue of list.issues) rememberTitle(projectId, issue.reference, issue.title);
			return list;
		},
		async content(params: unknown) {
			const target = designTarget(params);
			project(target.projectId, false);
			await restore(target.projectId, false);
			return (await service()).content(target.projectId, target.reference);
		},
		async designApproval(params: unknown, protocolVersion?: number) {
			if (
				protocolVersion !== undefined &&
				protocolVersion < ISSUES_DESIGN_APPROVAL_PROTOCOL_VERSION
			)
				throw new CodedError(
					"RESOURCE_UNAVAILABLE",
					"Issue design approvals are unavailable for this protocol version.",
				);
			const target = designTarget(params);
			// Membership only: this reads a receipt digest, never a credential or remote state.
			project(target.projectId, false);
			const receipts = join(root, "issue-workflow");
			// No store means no receipt at all; a read never creates or repairs one.
			if (!existsSync(receipts)) return { approvedDesignVersion: null };
			const record = await createIssueWorkflowPersistence(receipts).load(target.reference);
			return { approvedDesignVersion: approvedDesignVersion(record) };
		},
		async repositoryAddress(params: unknown) {
			const { projectId } = request(params);
			const found = project(projectId, true);
			if (found.kind === "group") return { repositoryUrl: null };
			return { repositoryUrl: await originRepositoryUrl(found.path) };
		},
	};
}

export const issuesHost = createIssuesHost();
export const issuesBeginDesign = issuesHost.beginDesign;
export const issuesBeginImplementation = issuesHost.beginImplementation;
export const issuesApproveDesign = issuesHost.approveDesign;
export const issuesApproveImplementation = issuesHost.approveImplementation;
export const issuesConnection = issuesHost.connection;
export const issuesConnect = issuesHost.connect;
export const issuesDesignApproval = issuesHost.designApproval;
export const issuesDisconnect = issuesHost.disconnect;
export const issuesList = issuesHost.list;
export const issuesContent = issuesHost.content;
export const issuesDetail = issuesHost.detail;
export const issuesLaunchDesign = issuesHost.launchDesign;
export const issuesLaunchImplementation = issuesHost.launchImplementation;
export const issuesPublishDesign = issuesHost.publishDesign;
export const issuesPublishImplementation = issuesHost.publishImplementation;
export const issuesRepositoryAddress = issuesHost.repositoryAddress;
export const issuesRepositories = issuesHost.repositories;
export const issuesSetRepositories = issuesHost.setRepositories;
export const issuesAddRepository = issuesHost.addRepository;
export const issuesCleanupRepositories = issuesHost.cleanupRepositories;
export const issuesImplementationRecovery = issuesHost.implementationRecovery;
export const issuesRecoverImplementation = issuesHost.recoverImplementation;
export { setIssueArchiveBarrier, setIssueWorkspaceArchiver } from "./issuesActions";
export const issuesStartImplementation = issuesHost.startImplementation;
export const issuesValidateDesign = issuesHost.validateDesign;
export const issuesValidateImplementation = issuesHost.validateImplementation;
