import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	canonicalIssueInstanceUrl,
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
	sessionReuseStatus,
	startInitialSessionPrompt,
} from "../agent";
import { gitAsync, originUrls } from "../git";
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
import { createIssueConfirmationStore } from "./issueConfirmations";
import { createIssueCredentials } from "./issueCredentials";
import { createIssueDeliveryActions, deliveryQuestions } from "./issueDeliveryActions";
import {
	createIssueSessionStore,
	type IssueSessionAssociation,
	type IssueSessionStore,
} from "./issueSessions";
import { createIssueStageActions, stageQuestions } from "./issueStageActions";
import { createIssuesActions, type IssueActionSessions, privateDirectory } from "./issuesActions";
import { createIssueWorkflowPersistence } from "./issueWorkflowPersistence";
import { createIssueWorkspacePersistence } from "./issueWorkspacePersistence";

function invalid(): never {
	throw new CodedError("RANGE_INVALID", "Invalid Issue request.");
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
			keys.some((key) => ![...connectionKeys, "httpConsent"].includes(key)) ||
			!isIssueConnectionInput(params.input)
		)
			invalid();
	}
	return params as Record<string, unknown> & { projectId: string };
}
function project(projectId: string, trusted: boolean) {
	const found = getProjects().find((candidate) => candidate.id === projectId);
	if (!found || found.kind === "chats")
		throw new CodedError("RESOURCE_UNAVAILABLE", "Issue project is unavailable.");
	if (trusted && found.trusted !== true)
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
const optionalStoredKeys = ["credentialId", "httpConsentInstanceUrl", "cleanupCredentialIds"];
function storedRow(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return (
		storedKeys.every((key) => typeof value[key] === "string") &&
		keys.every((key) => [...storedKeys, ...optionalStoredKeys].includes(key)) &&
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
		const [head, branch, status] = await Promise.all([
			gitAsync(repository.path, ["rev-parse", "HEAD"]),
			gitAsync(repository.path, ["symbolic-ref", "--short", "HEAD"]),
			gitAsync(repository.path, ["status", "--porcelain"]),
		]);
		if (!head.ok || !branch.ok || !status.ok) invalid();
		return { sha: head.out, branch: branch.out, dirty: status.out !== "" };
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
	function stages() {
		return createIssueStageActions({
			binding: confirmationBinding,
			journal: journal(),
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
			verifyAnswer: async (sessionId, payload, toolCallId) => {
				const binding = await confirmationBinding(sessionId);
				const ws = getWorkspace(binding.workspaceId);
				const { messages } = await getSessionMessages(
					sessionId,
					binding.workspaceId,
					ws.worktreePath,
				);
				if (!isTrustedQuestionnaireReceipt(messages, toolCallId, stageQuestions(payload)))
					invalid();
			},
		});
	}
	function deliveries() {
		return createIssueDeliveryActions({
			binding: confirmationBinding,
			journal: journal(),
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
			push: async (repository, input) => {
				const current = await trustedCheckout(repository);
				if (current.sha !== input.sha || current.branch !== input.branch || current.dirty)
					invalid();
				// Recheck immediately before dispatch: URL config may have changed since review.
				const urls = await originUrls(repository.path);
				const effective = urls.push ? await deliveryPushUrl(repository.path, urls.push) : null;
				if (!effective || effective !== safeRepositoryUrl(input.url)) invalid();
				const pushed = await gitAsync(repository.path, [
					"-c",
					"push.followTags=false",
					"push",
					"--",
					effective,
					`${input.sha}:refs/heads/${input.branch}`,
				]);
				if (!pushed.ok)
					throw new CodedError("RESOURCE_UNAVAILABLE", "Issue push requires reconciliation.");
			},
			verifyAnswer: async (sessionId, payload, toolCallId) => {
				const binding = await confirmationBinding(sessionId);
				const ws = getWorkspace(binding.workspaceId);
				const { messages } = await getSessionMessages(
					sessionId,
					binding.workspaceId,
					ws.worktreePath,
				);
				if (!isTrustedQuestionnaireReceipt(messages, toolCallId, deliveryQuestions(payload)))
					invalid();
			},
		});
	}
	const agentSessions = createIssueAgentSessionHost({
		service,
		prepareConfirmation: async (sessionId, input) => {
			if (input.projectId) {
				if (!input.title || input.body === undefined || input.report) invalid();
				return deliveries().prepare(sessionId, {
					operationId: input.operationId,
					projectId: input.projectId,
					title: input.title,
					body: input.body,
					...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
				});
			}
			if (!input.report || input.title || input.body || input.targetBranch) invalid();
			return stages().prepare(sessionId, { operationId: input.operationId, report: input.report });
		},
		executeConfirmation: async (sessionId, operationId, toolCallId) => {
			const stored = await journal().get(sessionId, operationId);
			if (!stored) invalid();
			return (stored.payload as { stage: string }).stage === "delivery"
				? deliveries().execute(sessionId, operationId, toolCallId)
				: stages().execute(sessionId, operationId, toolCallId);
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
			if (implementation?.state === "completed")
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
		sessionMemberWorkspaces,
		workspaceIssueBindings,
		groupIssueRecords,
		...actions,
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
			project(projectId, false);
			const issues = await service();
			// Reconstruct the write-only input; do not retain the ingress envelope.
			if (!isIssueConnectionInput(input)) invalid();
			return issues.connect(projectId, {
				instanceUrl: input.instanceUrl,
				projectId: input.projectId,
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
export { setIssueWorkspaceArchiver } from "./issuesActions";
export const issuesStartImplementation = issuesHost.startImplementation;
export const issuesValidateDesign = issuesHost.validateDesign;
export const issuesValidateImplementation = issuesHost.validateImplementation;
