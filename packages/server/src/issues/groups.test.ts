import { expect, test } from "bun:test";
import type { IssueConnectionInput, IssueReference } from "@thinkrail/contracts";
import { createGitLabGroupClient, createIssuesService, type IssueStoredBinding } from "./index";

const instanceUrl = "https://tracker.example:9443/gitlab";
const token = "disposable-group-fixture-token";
const input: IssueConnectionInput = {
	instanceUrl,
	projectId: "engineering/platform",
	scope: "group",
	token,
};
const metadata = (id: number, path: string) => ({
	id,
	path_with_namespace: path,
	http_url_to_repo: `${instanceUrl}/${path}.git`,
});
const row = (projectId: number) => ({
	project_id: projectId,
	iid: 12,
	title: `Project ${projectId} issue`,
	description: `Body ${projectId}`,
	state: "opened",
	labels: [],
	updated_at: "2026-01-01T00:00:00Z",
});
const reference = (projectId: string): IssueReference => ({
	provider: "gitlab",
	instanceUrl,
	projectId,
	number: 12,
});

function fixture() {
	let stored: IssueStoredBinding[] = [];
	const vault = new Map<string, string>();
	const requests: { url: URL; init: RequestInit }[] = [];
	let projects = [
		metadata(7, "engineering/platform/app"),
		metadata(9, "engineering/platform/sub/library"),
	];
	let rows = [row(7), row(9)];
	let override: ((url: URL) => Response | Promise<Response> | undefined) | undefined;
	const fetcher = async (value: string, init: RequestInit) => {
		const url = new URL(value);
		requests.push({ url, init });
		expect(new Headers(init.headers).get("PRIVATE-TOKEN")).toBe(token);
		expect(init.redirect).toBe("error");
		const replacement = override?.(url);
		if (replacement) return replacement;
		if (/\/groups\/(?:7|engineering%2Fplatform)$/.test(url.pathname))
			return Response.json({ id: 7, full_path: "engineering/platform" });
		if (url.pathname.endsWith("/groups/7/projects")) {
			expect(url.searchParams.get("include_subgroups")).toBe("true");
			expect(url.searchParams.get("with_shared")).toBe("false");
			return Response.json(projects);
		}
		if (url.pathname.endsWith("/groups/7/issues")) return Response.json(rows);
		const match = /\/projects\/(7|9)\/issues\/12(\/notes)?$/.exec(url.pathname);
		if (match) {
			const id = Number(match[1]);
			if (!match[2]) return Response.json(row(id));
			return Response.json([{ id, body: `Comment ${id}`, created_at: "2026-01-01T00:00:00Z" }]);
		}
		return Response.json({ error: "unexpected fixture request" }, { status: 404 });
	};
	const options = {
		persistence: {
			load: async () => structuredClone(stored),
			save: async (binding: IssueStoredBinding) => {
				stored = [structuredClone(binding)];
			},
		},
		credentialStore: {
			get: async (id: string) => vault.get(id) ?? null,
			set: async (id: string, value: string) => {
				vault.set(id, value);
			},
			delete: async (id: string) => {
				vault.delete(id);
			},
		},
		fetch: fetcher,
	};
	return {
		options,
		requests,
		vault,
		stored: () => stored,
		projects: (value: typeof projects) => {
			projects = value;
		},
		rows: (value: typeof rows) => {
			rows = value;
		},
		override: (value: typeof override) => {
			override = value;
		},
	};
}

test("a nested group includes owned subgroup projects and keeps equal IIDs distinct", async () => {
	const f = fixture();
	const service = await createIssuesService(f.options);
	expect(await service.connect("local", input)).toEqual({
		projectId: "local",
		instanceUrl,
		remoteProjectId: "7",
		scope: "group",
		connected: true,
	});
	const result = await service.list("local");
	expect(result.issues.map((issue) => issue.reference)).toEqual([reference("7"), reference("9")]);
	expect(result.issues.map((issue) => issue.projectPath)).toEqual([
		"engineering/platform/app",
		"engineering/platform/sub/library",
	]);
	expect(result.issues[1]?.url).toBe(`${instanceUrl}/engineering/platform/sub/library/-/issues/12`);
	expect(
		f.requests
			.find(({ url }) => url.pathname.endsWith("/groups/7/issues"))
			?.url.searchParams.get("scope"),
	).toBe("all");
	expect(JSON.stringify([result, f.stored(), service.connection("local")])).not.toContain(token);
});

test("details and workflow ports use the verified owning project", async () => {
	const f = fixture();
	const service = await createIssuesService(f.options);
	await service.connect("local", input);
	const detail = await service.detail("local", reference("9"));
	expect(detail.description).toBe("Body 9");
	expect(detail.comments[0]?.body).toBe("Comment 9");
	expect(detail.url).toBe(`${instanceUrl}/engineering/platform/sub/library/-/issues/12`);
	const client = service.remoteFor("local", reference("9"));
	expect((await client.issue(12)).description).toBe("Body 9");
	expect(client).toBe(service.workflowFor("local", reference("9")));
	expect(client).toBe(service.deliveryFor("local", reference("9")));
	const before = f.requests.length;
	expect(() => service.remoteFor("local", reference("99"))).toThrow();
	expect(() =>
		service.remoteFor("local", { ...reference("9"), instanceUrl: "https://elsewhere.example" }),
	).toThrow();
	expect(f.requests).toHaveLength(before);
});

test("group bindings restore lazily with verified members and disconnect retires the vault key", async () => {
	const f = fixture();
	let service = await createIssuesService(f.options);
	await service.connect("local", input);
	const before = f.requests.length;
	service = await createIssuesService(f.options);
	expect(f.requests).toHaveLength(before);
	expect(service.connection("local")).toMatchObject({ scope: "group", connected: false });
	await service.restore("local");
	expect((await service.content("local", reference("9"))).description).toBe("Body 9");
	await service.disconnect("local");
	expect(f.vault.size).toBe(0);
	expect(() => service.remoteFor("local", reference("9"))).toThrow();
});

test("refresh adds and removes group members without changing existing client identity", async () => {
	const f = fixture();
	const service = await createIssuesService(f.options);
	await service.connect("local", input);
	const original = service.remoteFor("local", reference("7"));
	f.projects([metadata(7, "engineering/platform/app")]);
	f.rows([row(7)]);
	await service.list("local");
	expect(service.remoteFor("local", reference("7"))).toBe(original);
	expect(() => service.remoteFor("local", reference("9"))).toThrow();
	f.projects([
		metadata(7, "engineering/platform/app"),
		metadata(9, "engineering/platform/sub/library"),
	]);
	f.rows([row(7), row(9)]);
	expect((await service.list("local")).issues).toHaveLength(2);
});

test("a late refresh cannot reinstall an older membership snapshot", async () => {
	const f = fixture();
	const service = await createIssuesService(f.options);
	await service.connect("local", input);
	let release: ((response: Response) => void) | undefined;
	let started: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		started = resolve;
	});
	f.override((url) => {
		if (!url.pathname.endsWith("/groups/7/projects")) return;
		started?.();
		return new Promise<Response>((resolve) => {
			release = resolve;
		});
	});
	const stale = service.list("local").then(
		() => true,
		() => false,
	);
	await held;
	f.override(undefined);
	f.projects([metadata(7, "engineering/platform/app")]);
	f.rows([row(7)]);
	await service.list("local");
	release?.(
		Response.json([
			metadata(7, "engineering/platform/app"),
			metadata(9, "engineering/platform/sub/library"),
		]),
	);
	expect(await stale).toBe(false);
	expect(() => service.remoteFor("local", reference("9"))).toThrow();
});

test("foreign catalog paths and unknown issue projects reject the whole group result", async () => {
	const f = fixture();
	const service = await createIssuesService(f.options);
	f.projects([metadata(9, "engineering/platform-other/repo")]);
	await expect(service.connect("local", input)).rejects.toThrow();
	expect(f.vault.size).toBe(0);
	f.projects([metadata(7, "engineering/platform/app")]);
	await service.connect("local", input);
	f.rows([row(7), row(99)]);
	await expect(service.list("local")).rejects.toThrow();
});

test("group pages are complete and a failed later page never becomes a partial result", async () => {
	const requests: string[] = [];
	let fail = false;
	const client = createGitLabGroupClient({
		instanceUrl,
		project: "engineering/platform",
		token,
		fetch: async (url) => {
			requests.push(url);
			const page = new URL(url).searchParams.get("page");
			if (page === "2" && fail) return Response.json({}, { status: 503 });
			return Response.json([row(page === "1" ? 7 : 9)], {
				headers: { "x-next-page": page === "1" ? "2" : "" },
			});
		},
	});
	expect((await client.issues()).map((issue) => issue.projectId)).toEqual([7, 9]);
	expect(requests[0]).toContain("/gitlab/api/v4/groups/engineering%2Fplatform/issues?");
	fail = true;
	await expect(client.issues()).rejects.toThrow();
});

test("group HTTP consent and numeric group identity are checked before committing credentials", async () => {
	const f = fixture();
	const service = await createIssuesService(f.options);
	await expect(
		service.connect("local", { ...input, instanceUrl: "http://tracker.example:8929" }),
	).rejects.toThrow();
	expect(f.requests).toHaveLength(0);
	f.override((url) =>
		url.pathname.endsWith("/groups/7")
			? Response.json({ id: 8, full_path: "engineering/platform" })
			: undefined,
	);
	await expect(service.connect("local", { ...input, projectId: "7" })).rejects.toThrow();
	expect(f.vault.size).toBe(0);
});
