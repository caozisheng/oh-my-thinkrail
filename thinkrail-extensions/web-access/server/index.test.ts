import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ExtensionSessionServices } from "@thinkrail/extension-api/server";
import extension from "./index";
import piWebAccess from "./piWebAccess.js";

const agentDir = mkdtempSync(join(tmpdir(), "web-access-agent-"));
writeFileSync(
	join(agentDir, "web-search.json"),
	JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15"], trustEnvProxy: true } }),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type Tool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ToolResult>;
};
type Handler = (event: { type: string }, ctx: unknown) => unknown;

async function startSession(allowRanges: readonly string[] = [], factory?: ExtensionFactory) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler[]>();
	const branch: unknown[] = [];
	const delivered = Promise.withResolvers<string>();
	let active = new Set<string>();
	const api = {
		registerTool: (tool: Tool) => {
			tools.set(tool.name, tool);
			active.add(tool.name);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = new Set(names);
		},
		appendEntry: (customType: string, data: unknown) => {
			branch.push({
				type: "custom",
				id: `entry-${branch.length}`,
				parentId: branch.length === 0 ? null : `entry-${branch.length - 1}`,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
		},
		sendMessage: (message: { content: string }) => delivered.resolve(message.content),
	};
	const extensionApi = new Proxy(api, {
		get: (target, key) => Reflect.get(target, key) ?? (() => {}),
	}) as unknown as ExtensionAPI;
	await (factory ?? ((pi) => piWebAccess(pi, allowRanges)))(extensionApi);
	const ctx = {
		hasUI: false,
		cwd: agentDir,
		ui: new Proxy({}, { get: () => () => {} }),
		sessionManager: { getBranch: () => branch },
	};
	const emit = async (type: string) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx);
	};
	await emit("session_start");
	return {
		async call(name: string, params: Record<string, unknown>): Promise<ToolResult> {
			const tool = tools.get(name);
			if (!tool) throw new Error(`${name} is not registered`);
			return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
		},
		firstDelivery: delivered.promise,
		shutdown: () => emit("session_shutdown"),
	};
}

const text = (result: ToolResult) => result.content.map((block) => block.text ?? "").join("\n");
const responseId = (result: ToolResult) => /responseId "([^"]+)"/.exec(text(result))?.[1] ?? "";
const settingsServices = (ranges: string[]): ExtensionSessionServices => ({
	expectToolResponse: () => {},
	awaitToolResponse: async () => ({ kind: "deferred" }),
	setting: () => false,
	cidrListSetting: () => [...ranges],
	workspaceFiles: {
		check: async () => {},
		checkArtifacts: async (paths) => paths.map((path) => ({ path })),
		ensureArtifactsDir: async () => {},
		scratchDir: "",
		artifactsDir: "",
	},
});
const article = (marker: string) =>
	`<!doctype html><html><head><title>${marker}</title></head><body><article><h1>${marker}</h1>${`<p>${marker} is the body of a long enough article for readable extraction to keep it whole, sentence after sentence.</p>`.repeat(8)}</article></body></html>`;

describe("web-access server half", () => {
	test("resolves configuration when the factory runs, after the agent directory is set", () => {
		const root = mkdtempSync(join(tmpdir(), "web-access-init-"));
		const initial = join(root, "initial");
		const configured = join(root, "configured");
		mkdirSync(initial);
		mkdirSync(configured);
		writeFileSync(
			join(configured, "web-search.json"),
			JSON.stringify({ toolActivation: "invalid-test-activation" }),
		);
		const source = `
const { default: factory } = await import(${JSON.stringify(new URL("./piWebAccess.js", import.meta.url).href)});
process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(configured)};
try {
	await factory(new Proxy({}, { get: () => () => {} }));
	process.exitCode = 1;
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("toolActivation")) throw error;
}
`;
		try {
			const result = Bun.spawnSync([process.execPath, "--eval", source], {
				env: { ...process.env, PI_CODING_AGENT_DIR: initial },
				timeout: 10_000,
			});
			expect(result.exitCode).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("composes pi-web-access for parents and children, with its skills", () => {
		expect(extension.name).toBe("web-access");
		expect(extension.title).toBe("Web access");
		expect(extension.description).toBeTruthy();
		expect(extension.extensions).toEqual([]);
		expect(extension.sessionExtensions).toBeFunction();
		expect(extension.childExtensions).toEqual([]);
		expect(extension.childSessionExtensions).toBeFunction();
		expect(extension.settings?.allowRanges).toEqual({ type: "cidr-list", default: [] });
		expect(extension.skillPackages).toEqual(["@thinkrail/ext-web-access"]);
	});

	test("the wrapped factory loads the package and registers its tools", async () => {
		const tools: string[] = [];
		const recording = new Proxy(
			{ registerTool: (tool: { name: string }) => tools.push(tool.name) },
			{ get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
		);
		await piWebAccess(recording as unknown as ExtensionAPI);
		expect(tools).toEqual(["web_search", "source_check", "fetch_content", "get_search_content"]);
	});

	test("one session ending or starting leaves another's stored results and background fetch alive", async () => {
		const slowRequested = Promise.withResolvers<void>();
		const slowReleased = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const { origin, pathname } = new URL(request.url);
				if (pathname === "/search") {
					return Response.json({
						results: [{ url: `${origin}/slow`, title: "Slow", content: "slow page" }],
					});
				}
				if (pathname === "/slow") {
					slowRequested.resolve();
					await slowReleased.promise;
				}
				return new Response(article(`page${pathname.replace("/", "-")}`), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		});
		const searxng = process.env.SEARXNG_BASE_URL;
		process.env.SEARXNG_BASE_URL = server.url.origin;
		try {
			const a = await startSession(["127.0.0.1/32"]);
			const b = await startSession(["127.0.0.1/32"]);
			const kept = responseId(await a.call("fetch_content", { url: `${server.url.origin}/kept` }));
			const other = responseId(
				await b.call("fetch_content", { url: `${server.url.origin}/other` }),
			);
			expect(kept).not.toBe("");
			expect(other).not.toBe("");
			const search = await a.call("web_search", {
				query: "slow",
				provider: "searxng",
				includeContent: true,
			});
			expect(search.isError).toBeFalsy();
			await slowRequested.promise;

			await b.shutdown();
			const reloaded = await startSession(["127.0.0.1/32"]);
			slowReleased.resolve();
			const delivered = await a.firstDelivery;
			const fetchId = /\[([^\]]+)\]/.exec(delivered)?.[1] ?? "";
			expect(delivered).toContain("Content fetched for 1/1 URLs");

			const background = await a.call("get_search_content", { responseId: fetchId, urlIndex: 0 });
			expect(text(background)).toContain("page-slow is the body");
			const stored = await a.call("get_search_content", { responseId: kept, urlIndex: 0 });
			expect(text(stored)).toContain("page-kept is the body");
			const released = await a.call("get_search_content", { responseId: other, urlIndex: 0 });
			expect(released.isError).toBe(true);
			await reloaded.shutdown();
			await a.shutdown();
		} finally {
			if (searxng === undefined) delete process.env.SEARXNG_BASE_URL;
			else process.env.SEARXNG_BASE_URL = searxng;
			slowReleased.resolve();
			await server.stop(true);
		}
	});

	test("CIDR exceptions are per bundled instance and do not rewrite user configuration", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) =>
				new URL(request.url).pathname === "/redirect"
					? new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } })
					: new Response(article("local page"), {
							headers: { "content-type": "text/html; charset=utf-8" },
						}),
		});
		try {
			const userConfigBefore = readFileSync(join(agentDir, "web-search.json"), "utf8");
			const denied = await startSession();
			const deniedResult = await denied.call("fetch_content", {
				url: `${server.url.origin}/denied`,
				mode: "raw",
			});
			expect(deniedResult.isError).toBe(true);
			await denied.shutdown();

			const ranges = ["127.0.0.1/32"];
			const [parentFactory] = extension.sessionExtensions?.(settingsServices(ranges)) ?? [];
			const [childFactory] =
				extension.childSessionExtensions?.({
					setting: () => false,
					cidrListSetting: () => ranges,
				}) ?? [];
			if (!parentFactory || !childFactory) throw new Error("web-access factories are missing");
			for (const factory of [parentFactory, childFactory]) {
				const allowed = await startSession([], factory);
				const allowedResult = await allowed.call("fetch_content", {
					url: `${server.url.origin}/allowed`,
					mode: "raw",
				});
				expect(allowedResult.isError).toBeFalsy();
				expect(responseId(allowedResult)).not.toBe("");
				const redirectResult = await allowed.call("fetch_content", {
					url: `${server.url.origin}/redirect`,
					mode: "raw",
				});
				expect(redirectResult.isError).toBe(true);
				expect(text(redirectResult)).toContain("Blocked internal address");
				await allowed.shutdown();
			}
			expect(readFileSync(join(agentDir, "web-search.json"), "utf8")).toBe(userConfigBefore);
		} finally {
			await server.stop(true);
		}
	});
});
