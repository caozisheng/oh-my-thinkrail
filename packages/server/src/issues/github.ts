import { issueProviderForInstanceUrl } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { logger } from "../log";
import type {
	IssueDeliveryRemote,
	IssueMergeRequest,
	IssueMergeRequestInput,
	IssueNote,
	IssueProject,
	IssueRecord,
} from "./remote";

export interface GitHubClientOptions {
	/** Canonical `https://github.com`; any other instance is rejected before a request. */
	instanceUrl: string;
	/** `owner/repo` while associating, the numeric repository id afterwards. */
	project: string | number;
	token: string;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	maxBytes?: number;
	maxPages?: number;
	maxItems?: number;
}
export type GitHubClient = IssueDeliveryRemote;

const log = logger("issues");
const API_ROOT = "https://api.github.com";
const PERMISSION_MESSAGE = "Issue token cannot read this repository or is rate limited.";

function invalid(): never {
	throw new CodedError("RANGE_INVALID", "Invalid GitHub Issue input or response.");
}
function unavailable(message = "Issue API request unavailable."): never {
	throw new CodedError("RESOURCE_UNAVAILABLE", message);
}
function limit(): never {
	throw new CodedError("RESOURCE_UNAVAILABLE", "Issue API resource limit exceeded.");
}
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string") invalid();
	return value;
}
function positive(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid();
	return value;
}
function timestamp(value: unknown): string {
	const result = text(value);
	if (!result || Number.isNaN(Date.parse(result))) invalid();
	return result;
}
function nullableText(value: unknown): string | null {
	return value === null || value === undefined ? null : text(value);
}
function cloneUrl(value: unknown): string | null {
	const result = nullableText(value);
	if (result === null) return null;
	if (result.startsWith("ssh://")) {
		const url = new URL(result);
		if (!url.hostname || url.password || url.search || url.hash || url.href !== result) invalid();
		return result;
	}
	if (/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+:[^:\s]+$/.test(result)) return result;
	const url = new URL(result);
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.pathname ||
		url.pathname === "/"
	)
		invalid();
	return result;
}
function pathWithNamespace(value: unknown): string {
	const result = text(value);
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result)) invalid();
	return result;
}
/** GitHub accepts a numeric repository id after association and `owner/repo` while connecting. */
function repository(project: string | number): { key: string; base: string } {
	const key =
		typeof project === "number"
			? String(positive(project))
			: /^\d+$/.test(project)
				? String(positive(Number(project)))
				: pathWithNamespace(project);
	return { key, base: /^\d+$/.test(key) ? `/repositories/${key}` : `/repos/${key}` };
}
function labels(value: unknown): { labels: string[]; labelColors: IssueRecord["labelColors"] } {
	if (!Array.isArray(value)) invalid();
	const labelColors: NonNullable<IssueRecord["labelColors"]> = [];
	const names = value.map((label) => {
		if (typeof label === "string") return label;
		const item = record(label);
		const name = text(item.name);
		if (typeof item.color === "string" && /^[a-fA-F0-9]{6}$/.test(item.color))
			labelColors.push({ name, color: `#${item.color.toUpperCase()}` });
		return name;
	});
	return { labels: names, ...(labelColors.length ? { labelColors } : {}) };
}
/** Pull requests share the issues endpoint; a record carrying `pull_request` is not an Issue. */
function issue(value: unknown): IssueRecord | null {
	const v = record(value);
	if (Object.hasOwn(v, "pull_request")) return null;
	if (v.state !== "open" && v.state !== "closed") invalid();
	const parsedLabels = labels(v.labels);
	return {
		iid: positive(v.number),
		title: text(v.title),
		description: v.body === null ? "" : text(v.body),
		state: v.state === "open" ? "opened" : "closed",
		...parsedLabels,
		updatedAt: timestamp(v.updated_at),
	};
}
function note(value: unknown): IssueNote {
	const v = record(value);
	const user = v.user == null ? null : record(v.user);
	return {
		id: positive(v.id),
		body: text(v.body),
		createdAt: timestamp(v.created_at),
		author: user ? { name: text(user.login), username: text(user.login) } : null,
		system: false,
	};
}
function identifier(value: unknown): string {
	const result = text(value);
	if (
		!result ||
		result.trim() !== result ||
		[...result].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		invalid();
	return result;
}
function branchName(value: unknown): string {
	const result = identifier(value);
	if (
		/\s|[~^:?*[\\]/.test(result) ||
		result.includes("..") ||
		result.includes("@{") ||
		result === "@" ||
		result.startsWith("-") ||
		result.endsWith(".") ||
		result.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
	)
		invalid();
	return result;
}
function sha(value: unknown): string | null {
	if (value == null) return null;
	const result = text(value);
	if (!/^[a-fA-F0-9]{40}$/.test(result)) invalid();
	return result;
}
function pullRequest(
	value: unknown,
	project: IssueProject,
	source: string,
	target?: string,
): IssueMergeRequest {
	const v = record(value);
	const head = record(v.head);
	const base = record(v.base);
	const sourceRepo = record(head.repo);
	const targetRepo = record(base.repo);
	const iid = positive(v.number);
	const sourceBranch = branchName(head.ref);
	const targetBranch = branchName(base.ref);
	if (
		sourceBranch !== source ||
		(target !== undefined && targetBranch !== target) ||
		positive(sourceRepo.id) !== project.id ||
		positive(targetRepo.id) !== project.id ||
		pathWithNamespace(sourceRepo.full_name) !== project.pathWithNamespace ||
		pathWithNamespace(targetRepo.full_name) !== project.pathWithNamespace ||
		(v.state !== "open" && v.state !== "closed")
	)
		invalid();
	const webUrl = text(v.html_url);
	if (webUrl !== `https://github.com/${project.pathWithNamespace}/pull/${iid}`) invalid();
	if (v.draft != null && typeof v.draft !== "boolean") invalid();
	if (v.merged_at != null) timestamp(v.merged_at);
	if (v.merged !== undefined && typeof v.merged !== "boolean") invalid();
	if (v.mergeable_state != null) identifier(v.mergeable_state);
	return {
		id: positive(v.id),
		iid,
		webUrl,
		state:
			v.merged === true || v.merged_at != null
				? "merged"
				: v.state === "open"
					? "opened"
					: "closed",
		sourceBranch,
		targetBranch,
		sha: sha(head.sha),
		mergeStatus: v.mergeable_state == null ? "unknown" : identifier(v.mergeable_state),
		sourceProjectId: project.id,
		targetProjectId: project.id,
		draft: v.draft == null ? null : (v.draft as boolean),
		detailedMergeStatus: nullableText(v.mergeable_state),
		mergeCommitSha: sha(v.merge_commit_sha),
		squashCommitSha: null,
		headPipeline: null,
	};
}
function nextPage(link: string | null): string | null {
	if (!link) return null;
	for (const part of link.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
		if (match?.[1]) return match[1];
	}
	return null;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
	if (issueProviderForInstanceUrl(options.instanceUrl) !== "github") invalid();
	const fetchImpl = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
	const timeoutMs = options.timeoutMs ?? 20_000;
	const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
	const maxPages = options.maxPages ?? 20;
	const maxItems = options.maxItems ?? 2_000;
	const token = options.token;
	if (!token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) invalid();
	const escapedToken = JSON.stringify(token).slice(1, -1);
	const encodedToken = encodeURIComponent(token);
	const { key: projectKey, base } = repository(options.project);
	async function request(
		path: string,
		deadline: number,
		write?: { method: "POST" | "PATCH"; body: Record<string, unknown> },
	): Promise<{ value: unknown; next: string | null }> {
		if (path.includes(token) || path.includes(encodedToken)) invalid();
		const payload = write && { body: JSON.stringify(write.body) };
		if (payload?.body.includes(escapedToken) || payload?.body.includes(encodedToken)) invalid();
		const remaining = deadline - Date.now();
		if (remaining <= 0) unavailable();
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		const work = async () => {
			const response = await fetchImpl(`${API_ROOT}${path}`, {
				method: write?.method ?? "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					...(payload ? { "Content-Type": "application/json" } : {}),
				},
				redirect: "error",
				signal: controller.signal,
				...(payload ? { body: payload.body } : {}),
			});
			if (response.status < 200 || response.status >= 300 || response.redirected) {
				await response.body?.cancel();
				// Classifier only: the status and redirect flag, never the URL, headers or body.
				log.warn(
					`github request rejected (status ${response.status}${response.redirected ? ", redirected" : ""})`,
				);
				if (response.status === 401) unavailable("Issue credential was rejected.");
				if (response.status === 403) unavailable(PERMISSION_MESSAGE);
				if (response.status === 404)
					unavailable("Issue repository or Issue is missing or not accessible.");
				unavailable();
			}
			const declared = response.headers.get("content-length");
			if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
				await response.body?.cancel();
				limit();
			}
			const reader = response.body?.getReader();
			if (!reader) invalid();
			activeReader = reader;
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > maxBytes) {
						await reader.cancel();
						limit();
					}
					chunks.push(part.value);
				}
			} finally {
				reader.releaseLock();
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			const serialized = JSON.stringify(value);
			if (serialized.includes(token) || serialized.includes(escapedToken)) unavailable();
			return { value, next: nextPage(response.headers.get("link")) };
		};
		try {
			return await Promise.race([
				work(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(unavailable());
					}, remaining);
				}),
			]);
		} catch (error) {
			controller.abort();
			void activeReader?.cancel().catch(() => undefined);
			if (error instanceof CodedError) throw error;
			throw unavailable();
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
	function relative(next: string, page: number): string {
		const url = new URL(next);
		if (
			url.origin !== API_ROOT ||
			url.username ||
			url.password ||
			url.hash ||
			url.searchParams.getAll("page").length !== 1 ||
			url.searchParams.get("page") !== String(page + 1)
		)
			invalid();
		return `${url.pathname}${url.search}`;
	}
	async function list<T>(path: string, parse: (value: unknown) => T, strict = false): Promise<T[]> {
		const result: T[] = [];
		const deadline = Date.now() + timeoutMs;
		let next: string | null = path;
		for (let page = 1; next !== null && page <= maxPages; page++) {
			const response = await request(next, deadline);
			if (!Array.isArray(response.value)) invalid();
			if (result.length + response.value.length > maxItems) limit();
			result.push(...response.value.map(parse));
			next = response.next === null ? null : relative(response.next, page);
			if (strict && next !== null) {
				const initial = new URL(path, API_ROOT);
				const following = new URL(next, API_ROOT);
				initial.searchParams.delete("page");
				following.searchParams.delete("page");
				initial.searchParams.sort();
				following.searchParams.sort();
				if (initial.href !== following.href) invalid();
			}
		}
		if (next !== null) limit();
		return result;
	}
	async function decoded<T>(path: string, parse: (value: unknown) => T): Promise<T> {
		return parse((await request(path, Date.now() + timeoutMs)).value);
	}
	const project = () =>
		decoded(base, (value) => {
			const v = record(value);
			const repositoryId = positive(v.id);
			const path = pathWithNamespace(v.full_name);
			if (
				/^\d+$/.test(projectKey)
					? repositoryId !== Number(projectKey)
					: path.toLowerCase() !== projectKey.toLowerCase()
			)
				invalid();
			return {
				id: repositoryId,
				pathWithNamespace: path,
				defaultBranch: nullableText(v.default_branch),
				httpUrlToRepo: cloneUrl(v.clone_url),
				sshUrlToRepo: cloneUrl(v.ssh_url),
			} satisfies IssueProject;
		});
	async function delivery<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch {
			return unavailable();
		}
	}
	return {
		provider: "github",
		project,
		updateIssue: async (iid, input) => {
			positive(iid);
			record(input);
			const body: Record<string, unknown> = {};
			if (input.description !== undefined) body.body = text(input.description);
			if (input.labels !== undefined) {
				if (!Array.isArray(input.labels)) invalid();
				body.labels = input.labels.map(identifier);
			}
			if (!Object.keys(body).length) invalid();
			return delivery(async () => {
				const response = await request(`${base}/issues/${iid}`, Date.now() + timeoutMs, {
					method: "PATCH",
					body,
				});
				const result = issue(response.value);
				if (!result || result.iid !== iid) invalid();
				return result;
			});
		},
		mergeRequests: async (sourceBranch) => {
			const source = branchName(sourceBranch);
			return delivery(async () => {
				const verified = await project();
				const owner = verified.pathWithNamespace.split("/")[0];
				const query = new URLSearchParams({
					state: "all",
					head: `${owner}:${source}`,
					per_page: "100",
				});
				return list(
					`${base}/pulls?${query}`,
					(value) => pullRequest(value, verified, source),
					true,
				);
			});
		},
		createMergeRequest: async (input: IssueMergeRequestInput) => {
			record(input);
			const source = branchName(input.sourceBranch);
			const target = branchName(input.targetBranch);
			const body: Record<string, unknown> = {
				head: source,
				base: target,
				title: identifier(input.title),
				body: text(input.description),
			};
			if (input.draft !== undefined) {
				if (typeof input.draft !== "boolean") invalid();
				body.draft = input.draft;
			}
			return delivery(async () => {
				const verified = await project();
				const response = await request(`${base}/pulls`, Date.now() + timeoutMs, {
					method: "POST",
					body,
				});
				const result = pullRequest(response.value, verified, source, target);
				if (input.draft !== undefined && result.draft !== input.draft) invalid();
				return result;
			});
		},
		issue: async (iid) => {
			const value = await decoded(`${base}/issues/${positive(iid)}`, issue);
			if (value === null) invalid();
			return value;
		},
		issues: async () =>
			(
				await list(`${base}/issues?state=all&sort=updated&direction=desc`, (value) => issue(value))
			).filter((entry): entry is IssueRecord => entry !== null),
		notes: (iid) => list(`${base}/issues/${positive(iid)}/comments`, note),
		addNote: async (iid, body) =>
			note(
				(
					await request(`${base}/issues/${positive(iid)}/comments`, Date.now() + timeoutMs, {
						method: "POST",
						body: { body: text(body) },
					})
				).value,
			),
	};
}
