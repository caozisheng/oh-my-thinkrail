import {
	canonicalIssueInstanceUrl,
	hasIssueHttpConsent,
	type IssueConnection,
	type IssueConnectionInput,
	type IssueContent,
	type IssueDetail,
	type IssueList,
	type IssueProvider,
	type IssueReference,
	type IssueStage,
	isIssueConnectionInput,
	isIssueReference,
	issueProviderForInstanceUrl,
	issueWebUrl,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { logger } from "../log";
import {
	createGitLabClient,
	createGitLabGroupClient,
	type GitLabClientOptions,
	type GitLabGroupClient,
	type GitLabIssue,
} from "./client";
import { createGitHubClient } from "./github";
import type { IssueDeliveryRemote, IssueRemote, IssueWorkflowRemote } from "./remote";

export type IssueBinding = Omit<IssueConnection, "connected">;

/** Opaque vault keys are host-only and never part of a public projection. */
export interface IssueStoredBinding extends IssueBinding {
	credentialId?: string;
	httpConsentInstanceUrl?: string;
	cleanupCredentialIds?: string[];
}

export interface IssueCredentialStore {
	get(id: string): Promise<string | null>;
	set(id: string, token: string): Promise<void>;
	delete(id: string): Promise<void>;
}

/** Save atomically upserts one metadata record by local project id. */
export interface IssueBindingPersistence {
	load(): Promise<readonly IssueStoredBinding[]>;
	save(binding: IssueStoredBinding): Promise<void>;
}

export interface IssuesServiceOptions {
	persistence: IssueBindingPersistence;
	credentialStore: IssueCredentialStore;
	fetch?: GitLabClientOptions["fetch"];
}

export interface IssuesService {
	connection(projectId: string): IssueConnection | null;
	connect(projectId: string, input: IssueConnectionInput): Promise<IssueConnection>;
	restore(projectId: string): Promise<IssueConnection | null>;
	disconnect(projectId: string): Promise<void>;
	list(projectId: string): Promise<IssueList>;
	content(projectId: string, reference: IssueReference): Promise<IssueContent>;
	detail(projectId: string, reference: IssueReference): Promise<IssueDetail>;
	/** Server-only authenticated read capability; never serialize or expose through RPC. */
	remoteFor(projectId: string, reference: IssueReference): IssueRemote;
	deliveryFor(projectId: string, reference: IssueReference): IssueDeliveryRemote;
	/** The GitLab-only workflow capability; a GitHub reference is refused before any request. */
	workflowFor(projectId: string, reference: IssueReference): IssueWorkflowRemote;
}

const log = logger("issues");

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxCleanup = 32;
function validToken(token: string): boolean {
	return (
		typeof token === "string" && token.length > 0 && token.length <= 4096 && /^[!-~]+$/.test(token)
	);
}
function publicBinding(binding: IssueBinding): IssueBinding {
	return {
		projectId: binding.projectId,
		instanceUrl: binding.instanceUrl,
		remoteProjectId: binding.remoteProjectId,
		...(binding.scope ? { scope: binding.scope } : {}),
	};
}
function storedBinding(row: IssueStoredBinding): IssueStoredBinding {
	const binding: IssueStoredBinding = bindingOf(
		row.projectId,
		row.instanceUrl,
		row.remoteProjectId,
		row.scope,
	);
	if (row.credentialId !== undefined) {
		if (typeof row.credentialId !== "string" || !uuid.test(row.credentialId)) invalid();
		binding.credentialId = row.credentialId;
	}
	if (row.httpConsentInstanceUrl !== undefined) {
		if (
			canonicalIssueInstanceUrl(row.httpConsentInstanceUrl) !== row.httpConsentInstanceUrl ||
			row.httpConsentInstanceUrl !== binding.instanceUrl
		)
			invalid();
		binding.httpConsentInstanceUrl = row.httpConsentInstanceUrl;
	}
	if (row.cleanupCredentialIds !== undefined) {
		if (
			!Array.isArray(row.cleanupCredentialIds) ||
			row.cleanupCredentialIds.length > maxCleanup ||
			row.cleanupCredentialIds.some(
				(id) => typeof id !== "string" || !uuid.test(id) || id === row.credentialId,
			) ||
			new Set(row.cleanupCredentialIds).size !== row.cleanupCredentialIds.length
		)
			invalid();
		binding.cleanupCredentialIds = [...row.cleanupCredentialIds];
	}
	return binding;
}

/** Closed stage labels only: no URL, token, provider text or error message is logged. */
type ConnectStage =
	| "consent"
	| "verify"
	| "metadata"
	| "vault-write"
	| "binding-save"
	| "cleanup"
	| "list-fetch"
	| "restore-vault"
	| "restore-verify";
function failAt(stage: ConnectStage): never {
	log.warn(`issue connection failed at ${stage}`);
	throw new CodedError("RESOURCE_UNAVAILABLE", "Issue connection unavailable.");
}

function invalid(): never {
	throw new CodedError("RANGE_INVALID", "Invalid Issue binding.");
}

function unavailable(message: string): never {
	throw new CodedError("RESOURCE_UNAVAILABLE", message);
}

function bindingOf(
	projectId: string,
	instanceUrl: string,
	remoteProjectId: string,
	scope?: "group",
): IssueBinding {
	const provider = issueProviderForInstanceUrl(instanceUrl);
	if (
		typeof projectId !== "string" ||
		!projectId.trim() ||
		provider === null ||
		(scope !== undefined && (scope !== "group" || provider !== "gitlab")) ||
		!isIssueReference({ provider, instanceUrl, projectId: remoteProjectId, number: 1 }) ||
		!/^[1-9]\d*$/.test(remoteProjectId) ||
		!Number.isSafeInteger(Number(remoteProjectId))
	)
		invalid();
	return {
		projectId,
		instanceUrl: canonicalIssueInstanceUrl(instanceUrl) ?? invalid(),
		remoteProjectId,
		...(scope ? { scope } : {}),
	};
}

function providerOf(instanceUrl: string): IssueProvider {
	return issueProviderForInstanceUrl(instanceUrl) ?? invalid();
}

/** Reads only; workflow actions still reject unknown or conflicting labels before any write. */
function stageOf(issue: GitLabIssue): IssueStage {
	if (issue.state === "closed") return "closed";
	const workflow = issue.labels.filter((label) => label.toLowerCase().startsWith("workflow::"));
	if (workflow.length !== 1) return "backlog";
	const [label] = workflow;
	return label === "workflow::in-progress"
		? "in-progress"
		: label === "workflow::in-review"
			? "in-review"
			: "backlog";
}

function projectPath(path: string, minimum = 2): string {
	// GitLab project paths contain slug segments. Do not interpret API text as a URL.
	const parts = path.split("/");
	if (parts.length < minimum || parts.some((part) => !/^[a-z\d_][a-z\d_.-]*$/i.test(part)))
		invalid();
	return parts.join("/");
}

export async function createIssuesService({
	persistence,
	credentialStore,
	fetch,
}: IssuesServiceOptions): Promise<IssuesService> {
	const bindings = new Map<string, IssueStoredBinding>();
	type ProjectClient = {
		client: IssueDeliveryRemote;
		workflow?: IssueWorkflowRemote;
		path: string;
		provider: IssueProvider;
	};
	type GroupClient = {
		group: GitLabGroupClient;
		path: string;
		provider: "gitlab";
		projects: Map<string, ProjectClient>;
		refreshId: number;
	};
	const clients = new Map<string, ProjectClient | GroupClient>();
	type Operation = { cancelled: boolean; done: Promise<unknown> };
	const pending = new Map<string, Operation>();
	const disconnecting = new Map<string, Promise<void>>();
	const blocked = new Set<string>();
	try {
		for (const row of await persistence.load()) {
			const binding = storedBinding(row);
			if (bindings.has(binding.projectId)) invalid();
			bindings.set(binding.projectId, binding);
		}
	} catch {
		return unavailable("Issue bindings could not be loaded.");
	}
	const connection = (id: string): IssueConnection | null => {
		const binding = bindings.get(id);
		return binding ? { ...publicBinding(binding), connected: clients.has(id) } : null;
	};
	const check = (operation: Operation) => {
		if (operation.cancelled) unavailable("Issue connection was cancelled.");
	};
	const save = async (binding: IssueStoredBinding) => {
		try {
			await persistence.save(structuredClone(binding));
		} catch {
			unavailable("Issue binding could not be saved.");
		}
		bindings.set(binding.projectId, binding);
	};
	const cleanup = async (id: string, operation?: Operation) => {
		const binding = bindings.get(id);
		if (!binding?.cleanupCredentialIds?.length) return;
		for (const key of binding.cleanupCredentialIds) {
			try {
				await credentialStore.delete(key);
			} catch {
				unavailable("Issue credential cleanup failed.");
			}
			if (operation) check(operation);
		}
		await save({ ...binding, cleanupCredentialIds: [] });
		if (operation) check(operation);
	};
	const run = <T>(id: string, work: (operation: Operation) => Promise<T>): Promise<T> => {
		const operation: Operation = { cancelled: false, done: Promise.resolve() };
		pending.set(id, operation);
		const done = Promise.resolve()
			.then(() => {
				check(operation);
				return work(operation);
			})
			.finally(() => {
				if (pending.get(id) === operation) pending.delete(id);
			});
		operation.done = done;
		return done;
	};
	/** One provider rule decides the transport; an unknown instance never guesses. */
	const makeClient = (instanceUrl: string, project: string, token: string): IssueDeliveryRemote => {
		const provider = issueProviderForInstanceUrl(instanceUrl) ?? invalid();
		const shared = { instanceUrl, project, token, ...(fetch ? { fetch } : {}) };
		return provider === "github" ? createGitHubClient(shared) : createGitLabClient(shared);
	};
	const workflowOf = (client: IssueRemote): IssueWorkflowRemote | undefined =>
		client.provider === "gitlab" ? (client as IssueWorkflowRemote) : undefined;
	const connected = (client: IssueDeliveryRemote, path: string): ProjectClient => {
		const workflow = workflowOf(client);
		return {
			client,
			...(workflow ? { workflow } : {}),
			path,
			provider: client.provider,
		};
	};
	const groupProjects = async (
		group: GitLabGroupClient,
		path: string,
		previous?: Map<string, ProjectClient>,
	) => {
		const projects = new Map<string, ProjectClient>();
		const paths = new Set<string>();
		for (const metadata of await group.projects()) {
			const memberPath = projectPath(metadata.pathWithNamespace);
			const id = String(metadata.id);
			if (!memberPath.startsWith(`${path}/`) || projects.has(id) || paths.has(memberPath))
				invalid();
			paths.add(memberPath);
			const old = previous?.get(id);
			projects.set(
				id,
				old?.path === memberPath ? old : connected(group.projectClient(metadata.id), memberPath),
			);
		}
		return projects;
	};
	const prepare = async (instanceUrl: string, target: string, token: string, scope?: "group") => {
		if (scope === "group") {
			const options = { instanceUrl, project: target, token, ...(fetch ? { fetch } : {}) };
			const metadata = await createGitLabGroupClient(options).group();
			const path = projectPath(metadata.fullPath, 1);
			const group = createGitLabGroupClient({ ...options, project: metadata.id });
			const source: GroupClient = {
				group,
				path,
				provider: "gitlab",
				projects: await groupProjects(group, path),
				refreshId: 0,
			};
			return { id: metadata.id, path, source };
		}
		const metadata = await makeClient(instanceUrl, target, token).project();
		const path = projectPath(metadata.pathWithNamespace);
		return {
			id: metadata.id,
			path,
			source: connected(makeClient(instanceUrl, String(metadata.id), token), path),
		};
	};
	const resolve = (projectId: string, reference: IssueReference) => {
		if (!isIssueReference(reference)) invalid();
		const binding = bindings.get(projectId);
		const source = clients.get(projectId);
		if (!binding || !source) return unavailable("Issue project is not connected.");
		if (reference.instanceUrl !== binding.instanceUrl || reference.provider !== source.provider)
			invalid();
		const member =
			"group" in source
				? source.projects.get(reference.projectId)
				: reference.projectId === binding.remoteProjectId
					? source
					: undefined;
		if (!member) invalid();
		return { binding, source, member };
	};
	const connect = (projectId: string, input: IssueConnectionInput): Promise<IssueConnection> => {
		if (typeof projectId !== "string" || !projectId.trim() || !isIssueConnectionInput(input))
			return Promise.reject(new CodedError("RANGE_INVALID", "Invalid Issue binding."));
		if (pending.has(projectId) || disconnecting.has(projectId) || blocked.has(projectId))
			return Promise.reject(
				new CodedError("RESOURCE_UNAVAILABLE", "Issue connection is busy or blocked."),
			);
		return run(projectId, async (operation) => {
			const instanceUrl = canonicalIssueInstanceUrl(input.instanceUrl) ?? invalid();
			const token = input.token;
			check(operation);
			if (!validToken(token)) invalid();

			const previous = bindings.get(projectId);
			if (
				!hasIssueHttpConsent(
					{ ...input, token },
					previous?.httpConsentInstanceUrl
						? { instanceUrl: previous.httpConsentInstanceUrl }
						: undefined,
				)
			)
				invalid();
			const project = await prepare(instanceUrl, input.projectId, token, input.scope).catch(() =>
				failAt("verify"),
			);
			check(operation);
			const path = project.path;
			const binding: IssueStoredBinding = bindingOf(
				projectId,
				instanceUrl,
				String(project.id),
				input.scope,
			);
			const link = input.scope
				? `${instanceUrl}/groups/${path}/-/issues`
				: issueWebUrl(providerOf(instanceUrl), instanceUrl, path, 1);
			if (
				[...Object.values(binding), link ?? ""].some(
					(field) => field.includes(token) || field.includes(encodeURIComponent(token)),
				)
			)
				invalid();
			if (instanceUrl.startsWith("http:")) binding.httpConsentInstanceUrl = instanceUrl;
			await cleanup(projectId, operation).catch(() => failAt("cleanup"));
			check(operation);
			const old = bindings.get(projectId);
			const credentialId = crypto.randomUUID();
			// Persist a deletion marker BEFORE a potentially uncertain vault write.
			const staged: IssueStoredBinding = {
				...(old ?? binding),
				cleanupCredentialIds: [credentialId],
			};
			await save(staged).catch(() => failAt("binding-save"));
			check(operation);
			try {
				await credentialStore.set(credentialId, token).catch(() => failAt("vault-write"));
				check(operation);
				await save({
					...binding,
					credentialId,
					cleanupCredentialIds: old?.credentialId ? [old.credentialId] : [],
				}).catch(() => failAt("binding-save"));
			} catch {
				// Never delete an active key, even if cancellation raced a successful metadata save.
				if (bindings.get(projectId)?.credentialId !== credentialId) {
					try {
						await cleanup(projectId);
					} catch {
						/* durable marker retains cleanup debt */
					}
				}
				unavailable("Issue credential or binding could not be saved.");
			}
			check(operation);
			clients.set(projectId, project.source);
			// Cleanup failure is reported, but the committed replacement remains live.
			await cleanup(projectId, operation);
			check(operation);
			return connection(projectId) ?? invalid();
		});
	};
	return {
		connection,
		connect,
		restore(projectId) {
			if (blocked.has(projectId) || disconnecting.has(projectId))
				return Promise.reject(
					new CodedError("RESOURCE_UNAVAILABLE", "Issue connection is blocked."),
				);
			const existing = pending.get(projectId);
			if (existing) return existing.done as Promise<IssueConnection | null>;
			if (clients.has(projectId)) return Promise.resolve(connection(projectId));
			return run(projectId, async (operation) => {
				await cleanup(projectId, operation);
				check(operation);
				const binding = bindings.get(projectId);
				if (!binding?.credentialId) return connection(projectId);
				let token: string | null;
				try {
					token = await credentialStore.get(binding.credentialId);
				} catch {
					log.warn("issue connection failed at restore-vault");
					unavailable("Issue credential could not be loaded.");
				}
				check(operation);
				if (token === null) return connection(projectId);
				if (!validToken(token)) invalid();
				const input = {
					instanceUrl: binding.instanceUrl,
					projectId: binding.remoteProjectId,
					token,
					...(binding.scope ? { scope: binding.scope } : {}),
				};
				if (
					!hasIssueHttpConsent(
						input,
						binding.httpConsentInstanceUrl
							? { instanceUrl: binding.httpConsentInstanceUrl }
							: undefined,
					)
				)
					invalid();
				const project = await prepare(
					binding.instanceUrl,
					binding.remoteProjectId,
					token,
					binding.scope,
				).catch(() => failAt("restore-verify"));
				check(operation);
				if (String(project.id) !== binding.remoteProjectId) invalid();
				const path = project.path;
				if (
					[...Object.values(publicBinding(binding)), path].some(
						(field) => field.includes(token) || field.includes(encodeURIComponent(token)),
					)
				)
					invalid();
				clients.set(projectId, project.source);
				return connection(projectId);
			});
		},
		disconnect(projectId) {
			clients.delete(projectId);
			blocked.add(projectId);
			const operation = pending.get(projectId);
			if (operation) operation.cancelled = true;
			const existing = disconnecting.get(projectId);
			if (existing) return existing;
			const done = (async () => {
				if (operation) await operation.done.catch(() => {});
				const binding = bindings.get(projectId);
				if (binding) {
					const keys = [
						...new Set([
							...(binding.cleanupCredentialIds ?? []),
							...(binding.credentialId ? [binding.credentialId] : []),
						]),
					];
					if (keys.length > maxCleanup) invalid();
					const retired = { ...binding, cleanupCredentialIds: keys };
					delete retired.credentialId;
					await save(retired);
					await cleanup(projectId);
				}
				blocked.delete(projectId);
			})().finally(() => disconnecting.delete(projectId));
			disconnecting.set(projectId, done);
			return done;
		},
		remoteFor(projectId, reference) {
			return resolve(projectId, reference).member.client;
		},
		deliveryFor(projectId, reference) {
			return resolve(projectId, reference).member.client;
		},

		workflowFor(projectId, reference) {
			if (!isIssueReference(reference)) invalid();
			if (reference.provider !== "gitlab")
				throw new CodedError(
					"RESOURCE_UNAVAILABLE",
					"Issue workflow actions are unavailable for this provider.",
				);
			return (
				resolve(projectId, reference).member.workflow ??
				unavailable("Issue project is not connected.")
			);
		},
		async content(projectId, reference) {
			const { binding, source, member: linked } = resolve(projectId, reference);
			const issue = await linked.client.issue(reference.number);
			if (
				clients.get(projectId) !== source ||
				("group" in source && source.projects.get(reference.projectId) !== linked)
			)
				unavailable("Issue connection changed during the read.");
			if (issue.iid !== reference.number) invalid();
			return {
				description: issue.description,
				url: issueWebUrl(linked.provider, binding.instanceUrl, linked.path, issue.iid) ?? invalid(),
			};
		},
		async detail(projectId, reference) {
			const { binding, source, member: connected } = resolve(projectId, reference);
			const issue = await connected.client.issue(reference.number);
			if (
				clients.get(projectId) !== source ||
				("group" in source && source.projects.get(reference.projectId) !== connected)
			)
				unavailable("Issue connection changed during the read.");
			if (issue.iid !== reference.number) invalid();
			const notes = await connected.client.notes(reference.number);
			if (
				clients.get(projectId) !== source ||
				("group" in source && source.projects.get(reference.projectId) !== connected)
			)
				unavailable("Issue connection changed during the read.");
			return {
				reference: { ...reference },
				title: issue.title,
				description: issue.description,
				url:
					issueWebUrl(connected.provider, binding.instanceUrl, connected.path, issue.iid) ??
					invalid(),
				comments: notes
					.filter((note) => !note.system)
					.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id)
					.map((note) => ({
						id: note.id,
						body: note.body,
						createdAt: note.createdAt,
						author: note.author ?? null,
					})),
				fetchedAt: new Date().toISOString(),
			};
		},
		async list(projectId) {
			const binding = bindings.get(projectId);
			const connected = clients.get(projectId);
			if (!binding || !connected) return unavailable("Issue project is not connected.");
			const refreshId = "group" in connected ? ++connected.refreshId : 0;
			const projects =
				"group" in connected
					? await groupProjects(connected.group, connected.path, connected.projects).catch(() =>
							failAt("list-fetch"),
						)
					: null;
			const rows =
				"group" in connected
					? (await connected.group.issues().catch(() => failAt("list-fetch"))).map((issue) => ({
							issue,
							remoteProjectId: String(issue.projectId),
						}))
					: (await connected.client.issues().catch(() => failAt("list-fetch"))).map((issue) => ({
							issue,
							remoteProjectId: binding.remoteProjectId,
						}));
			if (clients.get(projectId) !== connected)
				unavailable("Issue connection changed during the read.");
			if ("group" in connected && connected.refreshId !== refreshId)
				unavailable("Issue group refresh changed during the read.");
			const summaries = rows.map(({ issue, remoteProjectId }) => {
				const member =
					projects?.get(remoteProjectId) ?? (!("group" in connected) ? connected : invalid());
				return {
					reference: {
						provider: connected.provider,
						instanceUrl: binding.instanceUrl,
						projectId: remoteProjectId,
						number: issue.iid,
					},
					...(projects ? { projectPath: member.path } : {}),
					title: issue.title,
					url:
						issueWebUrl(connected.provider, binding.instanceUrl, member.path, issue.iid) ??
						invalid(),
					labels: issue.labels,
					...(issue.labelColors ? { labelColors: issue.labelColors } : {}),
					...(issue.assignees !== undefined ? { assignees: issue.assignees } : {}),
					...(issue.author !== undefined ? { author: issue.author } : {}),
					stage: stageOf(issue),
					updatedAt: issue.updatedAt,
				};
			});
			if ("group" in connected && projects) connected.projects = projects;
			return { issues: summaries, fetchedAt: new Date().toISOString() };
		},
	};
}
