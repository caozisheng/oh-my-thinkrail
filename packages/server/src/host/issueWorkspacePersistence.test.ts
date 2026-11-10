import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueReference } from "@thinkrail/contracts";
import { createIssueWorkspaceCoordinator, type IssueWorkspaceRecord } from "../issues";
import { createIssueWorkspacePersistence } from "./issueWorkspacePersistence";

const dirs: string[] = [];
const ref: IssueReference = {
	provider: "gitlab",
	instanceUrl: "https://gitlab.example",
	projectId: "12",
	number: 3,
};
const key = (r = ref, project = "local") =>
	JSON.stringify([project, r.provider, r.instanceUrl, r.projectId, r.number]);
const record: IssueWorkspaceRecord = {
	projectId: "local",
	reference: ref,
	design: { workspaceId: "default", sessionId: "session" },
};
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "issue-workspace-"));
	dirs.push(dir);
	return { dir, store: createIssueWorkspacePersistence(dir) };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture value");
	return value;
}
const failure = {
	code: "RESOURCE_UNAVAILABLE",
	message: "Issue workspace requires reconciliation.",
};

test("repository selections survive restart and reject duplicate, primary and foreign fields", async () => {
	const { dir, store } = setup();
	const selected = { ...record, repositoryProjectIds: ["api", "web"] };
	await store.withLaunch("local", ref, (p) => p.save(key(), selected));
	expect(
		await createIssueWorkspacePersistence(dir).withLaunch("local", ref, (p) => p.load(key())),
	).toEqual(selected);
	for (const repositoryProjectIds of [["local"], ["api", "api"], ["../api"], [""]]) {
		const f = setup();
		await expect(
			f.store.withLaunch("local", ref, (p) => p.save(key(), { ...record, repositoryProjectIds })),
		).rejects.toMatchObject(failure);
	}
});

test("auxiliary ownership round trips and rejects member identity drift", async () => {
	const f = setup();
	const selected = {
		...record,
		repositoryProjectIds: ["api"],
		members: [
			{
				projectId: "api",
				ownership: {
					state: "completed" as const,
					workspaceId: "api-ws",
					worktreePath: join(f.dir, "api-worktree"),
					branch: "issue-3-reserved",
				},
			},
		],
	};
	await f.store.withLaunch("local", ref, (p) => p.save(key(), selected));
	expect(
		await createIssueWorkspacePersistence(f.dir).withLaunch("local", ref, (p) => p.load(key())),
	).toEqual(selected);
	const other = setup();
	await expect(
		other.store.withLaunch("local", ref, (p) =>
			p.save(key(), { ...selected, repositoryProjectIds: ["web"] }),
		),
	).rejects.toMatchObject(failure);
});

test("a frozen group layout round trips and rejects drift, escapes and a layout without members", async () => {
	const f = setup();
	const selected: IssueWorkspaceRecord = {
		...record,
		repositoryProjectIds: ["api"],
		members: [{ projectId: "api" }],
		layout: {
			root: join(f.dir, "suite"),
			paths: [
				{ projectId: "local", path: "" },
				{ projectId: "api", path: "libs/api" },
			],
		},
	};
	await f.store.withLaunch("local", ref, (p) => p.save(key(), selected));
	expect(
		await createIssueWorkspacePersistence(f.dir).withLaunch("local", ref, (p) => p.load(key())),
	).toEqual(selected);
	const layout = required(selected.layout);
	for (const bad of [
		{ ...selected, members: undefined, repositoryProjectIds: undefined },
		{ ...selected, layout: { ...layout, root: "relative" } },
		{ ...selected, layout: { ...layout, paths: [...layout.paths].reverse() } },
		{ ...selected, layout: { ...layout, paths: layout.paths.slice(1) } },
		{ ...selected, layout: { ...layout, paths: [...layout.paths, layout.paths[1]] } },
		{ ...selected, members: [{ projectId: "api", base: "not-a-sha" }] },
		{ ...selected, members: [{ projectId: "api", removing: true }] },
		...["../api", "/abs", "libs//api", "libs\\api", "./api"].map((path) => ({
			...selected,
			layout: { ...layout, paths: [layout.paths[0], { projectId: "api", path }] },
		})),
	]) {
		const other = setup();
		const row = JSON.parse(JSON.stringify(bad));
		await expect(
			other.store.withLaunch("local", ref, (p) => p.save(key(), row)),
		).rejects.toMatchObject(failure);
	}
});

test("a layout may place group members that have not joined, and members keep base and removal intent", async () => {
	const f = setup();
	const row: IssueWorkspaceRecord = {
		...record,
		repositoryProjectIds: ["api"],
		members: [{ projectId: "api", base: "a".repeat(40), removing: true }],
		layout: {
			root: join(f.dir, "suite"),
			paths: [
				{ projectId: "local", path: "app" },
				{ projectId: "web", path: "web" },
				{ projectId: "root", path: "" },
			],
		},
	};
	await f.store.withLaunch("local", ref, (p) => p.save(key(), row));
	expect(
		await createIssueWorkspacePersistence(f.dir).withLaunch("local", ref, (p) => p.load(key())),
	).toEqual(row);
});

test("successful callbacks persist snapshots, release fences and disable retained ports", async () => {
	const { dir, store } = setup();
	let retained: Parameters<Parameters<typeof store.withLaunch>[2]>[0] | undefined;
	await store.withLaunch("local", ref, async (ports) => {
		retained = ports;
		expect(await ports.load(key())).toBeNull();
		await ports.save(key(), record);
	});
	expect(
		await createIssueWorkspacePersistence(dir).withLaunch("local", ref, (p) => p.load(key())),
	).toEqual(record);
	await expect(Promise.resolve().then(() => retained?.load(key()))).rejects.toMatchObject(failure);
	expect(readdirSync(dir).some((n) => n.endsWith(".lock"))).toBe(false);
});

test("a failed pre-release flush preserves the fence and prevents duplicate uncertain work", async () => {
	const { dir, store } = setup();
	const realFsync = fs.fsyncSync;
	let callbackDone = false;
	let operations = 0;
	const spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		if (callbackDone && fs.fstatSync(fd).isDirectory())
			throw Object.assign(new Error("injected flush failure"), { code: "EIO" });
		realFsync(fd);
	});
	try {
		await expect(
			store.withLaunch("local", ref, async (ports) => {
				operations++;
				await ports.save(key(), record);
				callbackDone = true;
			}),
		).rejects.toMatchObject(failure);
	} finally {
		spy.mockRestore();
	}
	expect(readdirSync(dir).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
	for (const adapter of [store, createIssueWorkspacePersistence(dir)]) {
		await expect(
			adapter.withLaunch("local", ref, async () => {
				operations++;
			}),
		).rejects.toMatchObject(failure);
	}
	expect(operations).toBe(1);
});

test("successful unlink commits release without a fallible later flush; retries reuse saved work", async () => {
	const { dir, store } = setup();
	const realFsync = fs.fsyncSync;
	let operations = 0;
	let postReleaseFlushes = 0;
	const spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		if (
			fs.fstatSync(fd).isDirectory() &&
			!readdirSync(dir).some((name) => name.endsWith(".lock"))
		) {
			postReleaseFlushes++;
			throw Object.assign(new Error("injected post-release flush failure"), { code: "EIO" });
		}
		realFsync(fd);
	});
	try {
		for (const adapter of [store, createIssueWorkspacePersistence(dir)]) {
			await expect(
				adapter.withLaunch("local", ref, async (ports) => {
					if (!(await ports.load(key()))) {
						operations++;
						await ports.save(key(), record);
					}
					return "completed";
				}),
			).resolves.toBe("completed");
		}
	} finally {
		spy.mockRestore();
	}
	expect(postReleaseFlushes).toBe(0);
	expect(operations).toBe(1);
	expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
});

test("failed callback fences retries and independent instances even before mutation", async () => {
	const { dir, store } = setup();
	await expect(
		store.withLaunch("local", ref, async () => {
			throw new Error("secret");
		}),
	).rejects.toMatchObject(failure);
	for (const adapter of [store, createIssueWorkspacePersistence(dir)]) {
		await expect(
			adapter.withLaunch("local", ref, async () => {
				throw new Error("must not run");
			}),
		).rejects.toMatchObject(failure);
	}
	await store.withLaunch("local", { ...ref, number: 4 }, async () => {});
	await expect(
		store.withLaunch("local", { ...ref, projectId: "99" }, async () => {}),
	).rejects.toMatchObject(failure);
});

test("settled startup failures release only their own fence and preserve pending records", async () => {
	const { dir, store } = setup();
	const pending = {
		...record,
		sessionPending: { stage: "design" as const, workspaceId: "default" },
	};
	let retained: Parameters<Parameters<typeof store.withLaunch>[2]>[0] | undefined;
	await expect(
		store.withLaunch(
			"local",
			ref,
			async (ports) => {
				retained = ports;
				await ports.save(key(), pending);
				throw new Error("injected startup failure");
			},
			undefined,
			"release-on-settle",
		),
	).rejects.toMatchObject(failure);
	expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
	await expect(Promise.resolve().then(() => retained?.load(key()))).rejects.toMatchObject(failure);
	await store.withLaunch("local", ref, async () => {
		await expect(
			createIssueWorkspacePersistence(dir).withLaunch(
				"local",
				ref,
				async () => {
					throw new Error("must not enter");
				},
				undefined,
				"release-on-settle",
			),
		).rejects.toThrow();
		expect(readdirSync(dir).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
	});
	expect(await store.withLaunch("local", ref, (ports) => ports.load(key()))).toEqual(pending);
});

test("startup validation and final guard failures release without deleting records", async () => {
	for (const boundary of ["validation", "guard"] as const) {
		const { dir, store } = setup();
		await expect(
			store.withLaunch(
				"local",
				ref,
				async (ports) => {
					await ports.save(key(), record);
					if (boundary === "validation") await ports.save("foreign", record);
				},
				() => {
					if (boundary === "guard") throw new Error("revoked");
				},
				"release-on-settle",
			),
		).rejects.toMatchObject(failure);
		expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
		expect(await store.withLaunch("local", ref, (ports) => ports.load(key()))).toEqual(record);
	}
});

test("startup release failure reports its own error and retains the fence", async () => {
	const { dir, store } = setup();
	const spy = spyOn(fs, "unlinkSync").mockImplementation(() => {
		throw new Error("injected release failure");
	});
	try {
		await expect(
			store.withLaunch(
				"local",
				ref,
				async () => {
					throw new Error("startup failed");
				},
				undefined,
				"release-on-settle",
			),
		).rejects.toMatchObject({ code: "ISSUE_LAUNCH_RELEASE_FAILED" });
	} finally {
		spy.mockRestore();
	}
	expect(readdirSync(dir).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
});

test("independent instances and a separate process contend before callback entry", async () => {
	const { dir, store } = setup();
	await store.withLaunch("local", ref, async () => {
		await expect(
			createIssueWorkspacePersistence(dir).withLaunch("local", ref, async () => {}),
		).rejects.toMatchObject(failure);
		const moduleUrl = new URL("./issueWorkspacePersistence.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`import {createIssueWorkspacePersistence} from ${JSON.stringify(moduleUrl)}; try { await createIssueWorkspacePersistence(${JSON.stringify(dir)}).withLaunch("local", ${JSON.stringify(ref)}, async () => { process.exit(9); }); process.exit(8); } catch(e) { process.exit(e.code === "RESOURCE_UNAVAILABLE" ? 0 : 7); }`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await child.exited).toBe(0);
	});
});

test("wrong keys and references fail closed", async () => {
	for (const mode of ["load", "save", "owner", "ref"]) {
		const { store } = setup();
		await expect(
			store.withLaunch("local", ref, async (p) => {
				if (mode === "load") await p.load(key({ ...ref, number: 4 }));
				else
					await p.save(mode === "save" ? "wrong" : key(), {
						...record,
						...(mode === "owner" ? { projectId: "other" } : {}),
						...(mode === "ref" ? { reference: { ...ref, projectId: "99" } } : {}),
					});
			}),
		).rejects.toMatchObject(failure);
	}
	const { store } = setup();
	await expect(
		store.withLaunch(
			"local",
			{ ...ref, instanceUrl: "https://secret@gitlab.example" },
			async () => {},
		),
	).rejects.toMatchObject(failure);
});

test("torn, oversized, unknown and invalid nested records halt before use", async () => {
	const invalid = [
		"{",
		" ".repeat(17000),
		JSON.stringify({ ...record, token: "secret" }),
		JSON.stringify({ ...record, design: { workspaceId: "w", extra: true } }),
		JSON.stringify({
			...record,
			implementation: { state: "pending", worktreePath: "relative", branch: "bad branch" },
		}),
		JSON.stringify({
			...record,
			sessionPending: { stage: "implementation", workspaceId: "w", version: "bad" },
		}),
		JSON.stringify({
			...record,
			implementation: {
				state: "completed",
				worktreePath: join(tmpdir(), ".worktrees", "3"),
				branch: "issue-3-reserved",
				workspaceId: "workspace",
				session: { id: "session", designVersion: `design:${"a".repeat(64)}` },
			},
		}),
	];
	for (const text of invalid) {
		const { dir, store } = setup();
		const name = `${createHash("sha256").update(key()).digest("hex")}.json`;
		writeFileSync(join(dir, name), text);
		await expect(store.withLaunch("local", ref, (p) => p.load(key()))).rejects.toMatchObject(
			failure,
		);
		expect(readFileSync(join(dir, name), "utf8")).toBe(text);
	}
});

test("round trips pending and completed associations without credentials", async () => {
	const { store } = setup();
	for (const implementation of [
		{
			state: "pending" as const,
			worktreePath: join(tmpdir(), ".worktrees", "3"),
			branch: "issue-3-reserved",
		},
		{
			state: "completed" as const,
			worktreePath: join(tmpdir(), ".worktrees", "3"),
			branch: "issue-3-reserved",
			workspaceId: "workspace",
			session: { id: "session" },
		},
	]) {
		const next = {
			...record,
			implementation,
			sessionPending: { stage: "design" as const, workspaceId: "default" },
		};
		await store.withLaunch("local", ref, async (p) => {
			await p.save(key(), next);
			expect(await p.load(key())).toEqual(next);
		});
	}
});

test("a fence left by a provably dead owner is reclaimed", async () => {
	const { dir, store } = setup();
	const moduleUrl = new URL("./issueWorkspacePersistence.ts", import.meta.url).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`import {createIssueWorkspacePersistence} from ${JSON.stringify(moduleUrl)}; await createIssueWorkspacePersistence(${JSON.stringify(dir)}).withLaunch("local", ${JSON.stringify(ref)}, async () => { process.exit(23); });`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(await child.exited).toBe(23);
	expect(readdirSync(dir).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
	await store.withLaunch("local", ref, async (ports) => {
		await ports.save(key(), record);
	});
	expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
});

test("an ownerless fence from an older build is reclaimed", async () => {
	const { dir, store } = setup();
	const lock = join(
		dir,
		`${createHash("sha256")
			.update(JSON.stringify(["local", 3]))
			.digest("hex")}.lock`,
	);
	writeFileSync(lock, JSON.stringify({ projectId: "local", number: 3 }));
	await store.withLaunch("local", ref, async (ports) => {
		await ports.save(key(), record);
	});
	expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
});

test("a fence held by a live owner is never reclaimed", async () => {
	const { dir } = setup();
	const moduleUrl = new URL("./issueWorkspacePersistence.ts", import.meta.url).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`import {createIssueWorkspacePersistence} from ${JSON.stringify(moduleUrl)}; await createIssueWorkspacePersistence(${JSON.stringify(dir)}).withLaunch("local", ${JSON.stringify(ref)}, async () => { console.log("held"); await Bun.sleep(30_000); });`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let output = "";
		while (!output.includes("held")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			output += decoder.decode(chunk.value);
		}
		expect(output).toContain("held");
		await expect(
			createIssueWorkspacePersistence(dir).withLaunch("local", ref, async () => {}),
		).rejects.toMatchObject(failure);
	} finally {
		child.kill();
		await child.exited;
	}
});

test("swallowed port errors cannot release a fence or overwrite a record", async () => {
	const { dir, store } = setup();
	await expect(
		store.withLaunch("local", ref, async (p) => {
			try {
				await p.save("wrong", record);
			} catch {}
		}),
	).rejects.toMatchObject(failure);
	expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
	await expect(store.withLaunch("local", ref, async () => {})).rejects.toMatchObject(failure);
});

test("ports wrap a whole coordinator launch and durably reuse its design session", async () => {
	const { dir, store } = setup();
	let creates = 0;
	const launch = () =>
		store.withLaunch("local", ref, async (ports) => {
			const coordinator = createIssueWorkspaceCoordinator({
				projectId: "local",
				projectPath: () => dir,
				...ports,
				findWorkspace: () => null,
				listGitWorktrees: () => [],
				createWorkspaceAtPath: () => {
					throw new Error("unexpected implementation");
				},
				defaultWorkspace: () => ({
					id: "default",
					projectId: "local",
					worktreePath: dir,
					branch: "main",
					kind: "default",
				}),
				sessionExists: () => "idle",
				createSession: () => {
					creates++;
					return "session";
				},
			});
			return coordinator.design(ref);
		});
	expect(await launch()).toEqual({ workspaceId: "default", sessionId: "session" });
	expect(await launch()).toEqual({ workspaceId: "default", sessionId: "session" });
	expect(creates).toBe(1);
});

test("pre-release guard follows required flushes and retains the fence on rejection", async () => {
	const { dir, store } = setup();
	const realOpen = fs.openSync;
	let flushedAfterCallback = false;
	let callbackDone = false;
	let guards = 0;
	const spy = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
		if (callbackDone && String(path) === dir) flushedAfterCallback = true;
		return realOpen(path, flags, mode);
	});
	try {
		await expect(
			store.withLaunch(
				"local",
				ref,
				async (ports) => {
					await ports.save(key(), record);
					callbackDone = true;
				},
				() => {
					guards++;
					expect(flushedAfterCallback).toBe(true);
					expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(true);
					throw new Error("capability revoked");
				},
			),
		).rejects.toMatchObject(failure);
	} finally {
		spy.mockRestore();
	}
	expect(guards).toBe(1);
	expect(readdirSync(dir).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
	await expect(store.withLaunch("local", ref, async () => {})).rejects.toMatchObject(failure);
});
