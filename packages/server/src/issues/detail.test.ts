import { expect, test } from "bun:test";
import { createIssuesService } from "./index";

const issue = {
	iid: 4,
	title: "Title",
	description: "**Body**",
	state: "opened",
	labels: [],
	updated_at: "2026-01-01T00:00:00Z",
};
const gitlabProject = { id: 7, path_with_namespace: "team/repo" };
const githubProject = { id: 7, full_name: "team/repo" };
const comment = (id: number, body: string, created_at: string, extra = {}) => ({
	id,
	body,
	created_at,
	...extra,
});

function fixture(
	provider: "gitlab" | "github",
	respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
	const calls: string[] = [];
	const vault = new Map<string, string>();
	const persistenceRows: { current: unknown[] } = { current: [] };
	return createIssuesService({
		persistence: {
			load: async () => persistenceRows.current as never,
			save: async (binding) => {
				persistenceRows.current = [binding];
			},
		},
		credentialStore: {
			get: async (id) => vault.get(id) ?? null,
			set: async (id, token) => {
				vault.set(id, token);
			},
			delete: async (id) => {
				vault.delete(id);
			},
		},
		fetch: async (url, init) => {
			const address = String(url);
			calls.push(address);
			return respond(address, init);
		},
	}).then(async (service) => {
		const input =
			provider === "gitlab"
				? { instanceUrl: "https://gitlab.example", projectId: "team/repo", token: "fixture-token" }
				: { instanceUrl: "https://github.com", projectId: "team/repo", token: "fixture-token" };
		await service.connect("local", input);
		return {
			service,
			calls,
			reference: {
				provider,
				instanceUrl: input.instanceUrl,
				projectId: "7",
				number: 4,
			} as const,
		};
	});
}

test("GitLab detail returns a complete ordered ordinary-comment snapshot", async () => {
	const notes = [
		comment(3, "later", "2026-01-02T00:00:00Z", {
			system: false,
			author: { name: "Alice", username: "alice", web_url: "https://private.example/alice" },
		}),
		comment(2, "label changed", "2026-01-01T00:00:00Z", { system: true }),
		comment(1, "first", "2026-01-01T00:00:00Z", {
			system: false,
			author: { name: "Bob", username: "bob" },
		}),
	];
	const { service, reference } = await fixture("gitlab", (url) =>
		Response.json(
			url.includes("/notes") ? notes : url.endsWith("/issues/4") ? issue : gitlabProject,
		),
	);
	const detail = await service.detail("local", reference);
	expect(detail).toEqual({
		reference,
		title: "Title",
		url: "https://gitlab.example/team/repo/-/issues/4",
		description: "**Body**",
		comments: [
			{
				id: 1,
				body: "first",
				createdAt: "2026-01-01T00:00:00Z",
				author: { name: "Bob", username: "bob" },
			},
			{
				id: 3,
				body: "later",
				createdAt: "2026-01-02T00:00:00Z",
				author: { name: "Alice", username: "alice" },
			},
		],
		fetchedAt: expect.any(String),
	});
	expect(Number.isFinite(Date.parse(detail.fetchedAt))).toBe(true);
	expect(JSON.stringify(detail)).not.toContain("private.example");
});

test("GitLab detail follows every note page and fails without returning a partial detail", async () => {
	const requested: string[] = [];
	const pageOne = [comment(1, "first", "2026-01-01T00:00:00Z", { system: false, author: null })];
	const pageTwo = [comment(2, "second", "2026-01-02T00:00:00Z", { system: false, author: null })];
	const { service, reference } = await fixture("gitlab", (url) => {
		requested.push(url);
		if (url.includes("/notes")) {
			const page = new URL(url).searchParams.get("page");
			return Response.json(page === "2" ? pageTwo : pageOne, {
				headers: { "x-next-page": page === "1" ? "2" : "" },
			});
		}
		return url.endsWith("/issues/4") ? Response.json(issue) : Response.json(gitlabProject);
	});
	const detail = await service.detail("local", reference);
	expect(detail.comments).toEqual([
		{ id: 1, body: "first", createdAt: "2026-01-01T00:00:00Z", author: null },
		{ id: 2, body: "second", createdAt: "2026-01-02T00:00:00Z", author: null },
	]);
	expect(requested.filter((url) => url.includes("/notes"))).toHaveLength(2);

	let noteCalls = 0;
	const failing = await fixture("gitlab", (url) => {
		if (url.includes("/notes")) {
			noteCalls++;
			return noteCalls === 1
				? Response.json(pageOne, { headers: { "x-next-page": "2" } })
				: new Response(null, { status: 503 });
		}
		return url.endsWith("/issues/4") ? Response.json(issue) : Response.json(gitlabProject);
	});
	await expect(failing.service.detail("local", failing.reference)).rejects.toHaveProperty(
		"code",
		"RESOURCE_UNAVAILABLE",
	);
	expect(noteCalls).toBe(2);
});

test("GitHub detail returns comment authors and empty comment lists exactly", async () => {
	const { service, reference } = await fixture("github", (url) => {
		if (url.endsWith("/issues/4/comments"))
			return Response.json([
				{ id: 10, body: "review", created_at: "2026-01-03T00:00:00Z", user: { login: "reviewer" } },
			]);
		if (url.endsWith("/issues/4"))
			return Response.json({ ...issue, number: issue.iid, body: issue.description, state: "open" });
		return Response.json(githubProject);
	});
	const detail = await service.detail("local", reference);
	expect(detail).toEqual({
		reference,
		title: "Title",
		url: "https://github.com/team/repo/issues/4",
		description: "**Body**",
		comments: [
			{
				id: 10,
				body: "review",
				createdAt: "2026-01-03T00:00:00Z",
				author: { name: "reviewer", username: "reviewer" },
			},
		],
		fetchedAt: expect.any(String),
	});

	const empty = await fixture("github", (url) => {
		if (url.endsWith("/issues/4/comments")) return Response.json([]);
		if (url.endsWith("/issues/4"))
			return Response.json({ ...issue, number: issue.iid, body: issue.description, state: "open" });
		return Response.json(githubProject);
	});
	expect((await empty.service.detail("local", empty.reference)).comments).toEqual([]);
});

test("detail rejects a changed binding and discards reads whose connection changes in flight", async () => {
	const { service, reference } = await fixture("gitlab", (url) =>
		Response.json(url.includes("/notes") ? [] : url.endsWith("/issues/4") ? issue : gitlabProject),
	);
	await expect(service.detail("local", { ...reference, projectId: "8" })).rejects.toThrow();

	let releaseIssue: ((response: Response) => void) | undefined;
	let issueRequested: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		issueRequested = resolve;
	});
	const pending = fixture("gitlab", (url) => {
		if (url.endsWith("/issues/4"))
			return new Promise<Response>((resolve) => {
				releaseIssue = resolve;
				issueRequested?.();
			});
		return Response.json(url.includes("/notes") ? [] : gitlabProject);
	});
	const live = await pending;
	const request = live.service.detail("local", live.reference);
	await started;
	await live.service.connect("local", {
		instanceUrl: "https://gitlab.example",
		projectId: "team/repo",
		token: "replacement-token",
	});
	releaseIssue?.(Response.json(issue));
	await expect(request).rejects.toHaveProperty("code", "RESOURCE_UNAVAILABLE");
	expect(live.calls.some((url) => url.includes("/notes"))).toBe(false);
});
