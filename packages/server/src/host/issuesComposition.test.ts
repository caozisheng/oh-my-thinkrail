import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProjects, saveWorkspaces } from "../persistence";
import { createIssueSessionStore } from "./issueSessions";
import { createIssuesHost } from "./issues";
import { createIssueWorkspacePersistence } from "./issueWorkspacePersistence";

let dir: string;
let repositoryPath: string;
let host: ReturnType<typeof createIssuesHost>;
const credentialValues = new Map<string, string>();
const credentials = {
	async get(id: string) {
		return credentialValues.get(id) ?? null;
	},
	async set(id: string, token: string) {
		credentialValues.set(id, token);
	},
	async delete(id: string) {
		credentialValues.delete(id);
	},
};
const reference = {
	provider: "gitlab" as const,
	instanceUrl: "https://gitlab.example",
	projectId: "42",
	number: 7,
};
let snapshot: { sha: string; tree: string; branch: string };
let upstreamMerged = false;
let upstreamMergeMethod: "merge" | "squash" | "fast-forward" = "merge";
let issueBody = "";
let bodyWrites = 0;
let failBodyWrite = false;
let remoteReads = 0;

beforeEach(async () => {
	upstreamMerged = false;
	upstreamMergeMethod = "merge";
	issueBody = "";
	bodyWrites = 0;
	failBodyWrite = false;
	remoteReads = 0;
	dir = mkdtempSync(join(tmpdir(), "issues-composition-"));
	const primaryPath = join(dir, "repo");
	repositoryPath = join(primaryPath, ".worktrees", "issue-7");
	mkdirSync(join(primaryPath, ".worktrees"), { recursive: true });
	const run = (...args: string[]) => Bun.spawnSync(["git", "-C", primaryPath, ...args]);
	if (!run("init", "-q").success) throw new Error("git init failed");
	if (
		!run(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"commit",
			"--allow-empty",
			"-m",
			"initial",
		).success
	)
		throw new Error("git commit failed");
	if (!run("worktree", "add", "-b", "issue-7-composition", repositoryPath, "HEAD").success)
		throw new Error("Issue worktree creation failed");
	const worktree = (...args: string[]) => Bun.spawnSync(["git", "-C", repositoryPath, ...args]);
	snapshot = {
		sha: worktree("rev-parse", "HEAD").stdout.toString().trim(),
		tree: worktree("rev-parse", "HEAD^{tree}").stdout.toString().trim(),
		branch: worktree("branch", "--show-current").stdout.toString().trim(),
	};
	saveProjects([
		{ id: "repo", name: "repo", slug: "repo", path: primaryPath, lastOpened: 1, trusted: true },
	]);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "repo",
			name: "Issue 7",
			branch: snapshot.branch,
			baseBranch: "main",
			worktreePath: repositoryPath,
		},
	]);
	const sessions = join(dir, "issue-sessions");
	mkdirSync(sessions, { recursive: true });
	await createIssueSessionStore(sessions).bind({
		sessionId: "session",
		workspaceId: "workspace",
		projectId: "repo",
		reference,
		stage: "implementation",
		locale: "en",
	});
	const issueWorkspacePath = join(dir, "issue-workspaces");
	mkdirSync(issueWorkspacePath, { recursive: true });
	const issueWorkspaceStore = createIssueWorkspacePersistence(issueWorkspacePath);
	await issueWorkspaceStore.withLaunch("repo", reference, (ports) =>
		ports.save(JSON.stringify(["repo", "gitlab", reference.instanceUrl, "42", 7]), {
			projectId: "repo",
			reference,
			design: { workspaceId: "design-workspace", sessionId: "design-session" },
			implementation: {
				state: "completed",
				workspaceId: "workspace",
				worktreePath: repositoryPath,
				branch: snapshot.branch,
			},
		}),
	);
	host = createIssuesHost({
		dir,
		credentials,
		fetch: (async (url, init) => {
			const address = String(url);
			if (!init?.method || init.method === "GET") remoteReads++;
			if (address.includes("/issues/7") && init?.method === "PUT") {
				issueBody = JSON.parse(String(init.body)).description;
				bodyWrites++;
				if (failBodyWrite) throw new Error("response lost after dispatch");
			}
			if (address.includes("/api/v4/projects/43"))
				return new Response(JSON.stringify({ id: 43, path_with_namespace: "group/downstream" }));
			if (upstreamMerged && address.includes("/repository/merge_base?"))
				return new Response(JSON.stringify({ id: snapshot.sha }));
			if (address.includes("/api/v4/issues/7") || address.includes("/api/v4/projects/42/issues/7"))
				return new Response(
					JSON.stringify({
						iid: 7,
						title: "Fixture",
						description: issueBody,
						state: "opened",
						labels: [],
						updated_at: "2026-01-01T00:00:00Z",
					}),
				);
			if (address.includes("/issues?")) return new Response("[]");
			if (address.includes("/api/v4/projects/42/merge_requests/7"))
				return new Response(
					JSON.stringify({
						id: 7,
						iid: 7,
						web_url: "https://gitlab.example/sub/group/repo/-/merge_requests/7",
						state: upstreamMerged ? "merged" : "opened",
						...(upstreamMerged && upstreamMergeMethod === "merge"
							? { merge_commit_sha: snapshot.sha }
							: {}),
						...(upstreamMerged && upstreamMergeMethod === "squash"
							? { squash_commit_sha: snapshot.sha }
							: {}),
						source_branch: snapshot.branch,
						target_branch: "main",
						sha: upstreamMerged && upstreamMergeMethod === "squash" ? "e".repeat(40) : snapshot.sha,
						merge_status: "cannot_be_merged",
						detailed_merge_status: "not_approved",
						draft: true,
						title: "Draft: Fixture",
						commit: { id: snapshot.sha },
						source_project_id: 42,
						target_project_id: 42,
						last_commit: { id: snapshot.sha },
						pipelines: [],
					}),
				);
			if (address.includes("/api/v4/projects/42/repository/branches/main"))
				return new Response(JSON.stringify({ name: "main", commit: { id: snapshot.sha } }));
			if (address.includes("/merge_requests/7"))
				return new Response(
					JSON.stringify({
						id: 7,
						iid: 7,
						web_url: "https://gitlab.example/sub/group/repo/-/merge_requests/7",
						state: upstreamMerged ? "merged" : "opened",
						...(upstreamMerged ? { merge_commit_sha: snapshot.sha } : {}),
						source_branch: snapshot.branch,
						target_branch: "main",
						sha: snapshot.sha,
						merge_status: "cannot_be_merged",
						detailed_merge_status: "not_approved",
						draft: false,
						title: "Fixture",
						commit: { id: snapshot.sha },
						source_project_id: 42,
						target_project_id: 42,
						last_commit: { id: snapshot.sha },
						pipelines: [],
					}),
				);
			return new Response(JSON.stringify({ id: 42, path_with_namespace: "group/repo" }));
		}) as typeof fetch,
	});
	await host.connect({
		projectId: "repo",
		input: { instanceUrl: reference.instanceUrl, projectId: "group/repo", token: "test-token" },
	});
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("host composition records and reads delivery state without a confirmation", async () => {
	const prepare = host.agentSessions.prepareConfirmation;
	if (!prepare) throw new Error("Issue confirmation tool is unavailable");
	expect(
		await prepare("session", { operationId: "read", action: "read-delivery-state" }),
	).toMatchObject({
		revision: 0,
		repositories: [],
		participating: [{ projectId: "repo", worktreeId: "workspace", ...snapshot }],
	});
	const deliveryState = {
		repositories: [
			{
				projectId: "repo",
				worktreeId: "workspace",
				sourceBranch: snapshot.branch,
				targetBranch: "main",
				policy: "draft",
				dependsOn: [],
				checkoutSha: snapshot.sha,
				checkoutTree: snapshot.tree,
				validations: [],
				mergeRequestId: 7,
				updatedAt: new Date().toISOString(),
			},
		],
	};
	const result = await prepare("session", {
		operationId: "record",
		action: "record-delivery-state",
		expectedRevision: 0,
		deliveryState,
	});
	expect(result).toMatchObject({
		revision: 1,
		repositories: [
			expect.objectContaining({
				projectId: "repo",
				mergeRequest: expect.objectContaining({ iid: 7 }),
			}),
		],
	});
	expect(
		await prepare("session", { operationId: "read-after-write", action: "read-delivery-state" }),
	).toMatchObject({
		revision: 1,
	});
});

test("dependency preflight names incomplete registration before merge or compatibility checks", async () => {
	const prepare = host.agentSessions.prepareConfirmation;
	if (!prepare) throw new Error("Issue confirmation tool is unavailable");
	const result = await prepare("session", {
		operationId: "dependency-registration",
		action: "preflight-dependencies",
		projectId: "repo",
	});
	expect(result).toMatchObject({
		status: "blocked",
		reason: expect.stringContaining('delivery-state-incomplete); revision=0; missing=["repo"]'),
		nextAction: expect.stringContaining("record-delivery-state"),
	});
});

test("direct Issue close reports actionable missing close fields without writing a note", async () => {
	const run = host.agentSessions.runOperation;
	if (!run) throw new Error("Direct Issue operation is unavailable");
	await expect(
		run("session", { operationId: "close-missing-fields", action: "close-issue" }),
	).rejects.toThrow("Issue close requires non-empty reason and acceptance fields.");
	expect(bodyWrites).toBe(0);
});

test("MR ready and merge are reached through the composed host routes", async () => {
	const prepare = host.agentSessions.prepareConfirmation;
	if (!prepare) throw new Error("Issue confirmation tool is unavailable");
	const ready = await prepare("session", {
		operationId: "ready-mr",
		action: "ready-mr",
		projectId: "repo",
		mergeRequestId: 7,
		targetBranch: "main",
		expectedSha: snapshot.sha,
	});
	expect(ready).toMatchObject({ digest: expect.any(String) });
	await expect(
		prepare("session", {
			operationId: "merge-mr",
			action: "merge-mr",
			projectId: "repo",
			mergeRequestId: 7,
			targetBranch: "main",
			expectedSha: snapshot.sha,
		}),
	).resolves.toMatchObject({ status: "blocked" });
});

async function compatibilityFixture(mode: "pass" | "missing" | "failed" | "dirty") {
	upstreamMerged = true;
	const primaryPath = join(dir, "downstream");
	mkdirSync(primaryPath);
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", primaryPath, ...args]);
		if (!result.success) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	git("init", "-q");
	git(
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"commit",
		"--allow-empty",
		"-m",
		"initial",
	);
	const key = JSON.stringify(["repo", "gitlab", reference.instanceUrl, "42", 7]);
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
	const path = join(primaryPath, ".worktrees", `issue-7-${digest}`);
	mkdirSync(join(primaryPath, ".worktrees"));
	git("worktree", "add", "-b", "issue-7-downstream", path, "HEAD");
	const checkout = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", path, ...args]);
		if (!result.success) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	if (mode !== "missing") {
		mkdirSync(join(path, ".thinkrail"));
		writeFileSync(
			join(path, "compatibility.ts"),
			`
import { readFileSync } from "node:fs";
const context = JSON.parse(process.env.THINKRAIL_ISSUE_COMPATIBILITY_CONTEXT!);
const git = (ref: string) => Bun.spawnSync(["git", "rev-parse", ref]).stdout.toString().trim();
const upstream = ${JSON.stringify({
				projectId: "repo",
				provider: "gitlab",
				instanceUrl: reference.instanceUrl,
				remoteProjectId: 42,
				iid: 7,
				targetBranch: "main",
				mergeCommitSha: snapshot.sha,
				targetSha: snapshot.sha,
				snapshot: JSON.stringify([7, 7, "main", snapshot.sha, snapshot.sha, "ancestor"]),
			})};
if (process.argv[2] !== "argument with spaces" ||
    context.projectId !== "downstream" || context.downstreamSha !== git("HEAD") ||
    context.downstreamTree !== git("HEAD^{tree}") ||
    JSON.stringify(context.upstream) !== JSON.stringify(upstream) ||
    readFileSync("version.txt", "utf8") !== "fixture-v1") process.exit(8);
process.exit(${mode === "failed" ? 9 : 0});
`,
		);
		writeFileSync(join(path, "version.txt"), "fixture-v1");
		writeFileSync(
			join(path, ".thinkrail", "issue-compatibility.json"),
			JSON.stringify({
				version: 1,
				command: [process.execPath, "compatibility.ts", "argument with spaces"],
				timeoutMs: 5000,
				coverage: {
					api: "checked",
					abi: "not-applicable",
					protocol: "checked",
					conflict: "checked",
					checks: "checked",
				},
			}),
		);
		checkout("add", ".");
		checkout(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"commit",
			"-m",
			"compatibility fixture",
		);
	}
	const downstream = {
		sha: checkout("rev-parse", "HEAD"),
		tree: checkout("rev-parse", "HEAD^{tree}"),
		branch: checkout("branch", "--show-current"),
	};
	saveProjects([
		{
			id: "repo",
			name: "repo",
			slug: "repo",
			path: join(dir, "repo"),
			lastOpened: 1,
			trusted: true,
		},
		{
			id: "downstream",
			name: "downstream",
			slug: "downstream",
			path: primaryPath,
			lastOpened: 1,
			trusted: true,
		},
	]);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "repo",
			name: "Issue 7",
			branch: snapshot.branch,
			baseBranch: "main",
			worktreePath: repositoryPath,
		},
		{
			id: "downstream-workspace",
			projectId: "downstream",
			name: "Issue 7",
			branch: downstream.branch,
			baseBranch: "main",
			worktreePath: path,
		},
	]);
	const store = createIssueWorkspacePersistence(join(dir, "issue-workspaces"));
	await store.withLaunch("repo", reference, (ports) =>
		ports.save(key, {
			projectId: "repo",
			reference,
			implementation: {
				state: "completed",
				workspaceId: "workspace",
				worktreePath: repositoryPath,
				branch: snapshot.branch,
			},
			repositoryProjectIds: ["downstream"],
			members: [
				{
					projectId: "downstream",
					ownership: {
						state: "completed",
						workspaceId: "downstream-workspace",
						worktreePath: path,
						branch: downstream.branch,
					},
				},
			],
		}),
	);
	await host.connect({
		projectId: "downstream",
		input: {
			instanceUrl: reference.instanceUrl,
			projectId: "group/downstream",
			token: "test-token",
		},
	});
	const prepare = host.agentSessions.prepareConfirmation;
	if (!prepare) throw new Error("Issue confirmation tool is unavailable");
	expect(
		await prepare("session", { operationId: "membership", action: "read-delivery-state" }),
	).toMatchObject({
		participating: [
			expect.objectContaining({ projectId: "repo", ...snapshot }),
			expect.objectContaining({ projectId: "downstream", ...downstream }),
		],
	});
	expect(
		await prepare("session", {
			operationId: "register-pair",
			action: "record-delivery-state",
			expectedRevision: 0,
			deliveryState: {
				repositories: [
					{
						projectId: "repo",
						worktreeId: "workspace",
						sourceBranch: snapshot.branch,
						targetBranch: "main",
						policy: "draft",
						dependsOn: [],
						checkoutSha: snapshot.sha,
						checkoutTree: snapshot.tree,
						validations: [],
						mergeRequestId: 7,
						updatedAt: new Date().toISOString(),
					},
					{
						projectId: "downstream",
						worktreeId: "downstream-workspace",
						sourceBranch: downstream.branch,
						targetBranch: "main",
						policy: "draft",
						dependsOn: ["repo"],
						checkoutSha: downstream.sha,
						checkoutTree: downstream.tree,
						validations: [],
						updatedAt: new Date().toISOString(),
					},
				],
			},
		}),
	).toMatchObject({ revision: 1 });
	if (mode === "dirty") writeFileSync(join(path, "version.txt"), "uncommitted-version");
	return {
		downstream,
		result: await prepare("session", {
			operationId: "real-compatibility",
			action: "preflight-dependencies",
			projectId: "downstream",
		}),
	};
}

test("composed dependency preflight accepts real argv compatibility for exact repository versions", async () => {
	const { downstream, result } = await compatibilityFixture("pass");
	expect(result).toMatchObject({
		status: "passed",
		receipt: {
			projectId: "downstream",
			downstreamSha: downstream.sha,
			downstreamTree: downstream.tree,
			upstreams: [
				expect.objectContaining({
					projectId: "repo",
					mergeCommitSha: snapshot.sha,
					targetSha: snapshot.sha,
				}),
			],
			compatibility: [
				expect.objectContaining({
					kind: "cross-repository",
					downstreamSha: downstream.sha,
					downstreamTree: downstream.tree,
					upstreamMergeSha: snapshot.sha,
					api: "passed",
					abi: "not-applicable",
					checks: "passed",
					snapshot: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			],
		},
	});
}, 20_000);

for (const method of ["squash", "fast-forward"] as const) {
	test(`registered ${method} upstream passes dependency preflight using the proven merged result`, async () => {
		upstreamMergeMethod = method;
		const { result } = await compatibilityFixture("pass");
		expect(result).toMatchObject({
			status: "passed",
			receipt: {
				upstreams: [{ projectId: "repo", mergeCommitSha: snapshot.sha }],
				compatibility: [{ upstreamMergeSha: snapshot.sha }],
			},
		});
	}, 20_000);
}

for (const [mode, reason] of [
	["missing", "compatibility-missing"],
	["failed", "compatibility-failed"],
	["dirty", "checkout-changed-or-dirty"],
] as const) {
	test(`composed dependency preflight refuses ${mode} compatibility`, async () => {
		const { result } = await compatibilityFixture(mode);
		expect(result).toMatchObject({ status: "blocked", reason: expect.stringContaining(reason) });
		expect(result).not.toHaveProperty("receipt");
	}, 20_000);
}

test("direct body operation freezes and writes without a questionnaire; legacy execution stays gated", async () => {
	const run = host.agentSessions.runOperation;
	if (!run) throw new Error("Direct Issue tool unavailable");
	const prepare = host.agentSessions.prepareConfirmation;
	const execute = host.agentSessions.executeConfirmation;
	if (!prepare || !execute) throw new Error("Legacy Issue tools unavailable");
	await run("session", { operationId: "direct-body", action: "update-body", body: "Updated" });
	expect(issueBody).toBe("Updated");
	expect(bodyWrites).toBe(1);
	const state = await prepare("session", {
		operationId: "direct-body",
		inspect: true,
	});
	expect(state).toMatchObject({ status: "completed" });
	await prepare("session", {
		operationId: "legacy-body",
		action: "update-body",
		body: "Legacy",
	});
	await expect(execute("session", "legacy-body", "fake-receipt")).rejects.toThrow();
	expect(bodyWrites).toBe(1);
});

test("direct operations reject inspection automation and foreign sessions; absent recovery is read-only", async () => {
	const run = host.agentSessions.runOperation;
	if (!run) throw new Error("Direct Issue tool unavailable");
	for (const input of [
		{ operationId: "inspect", inspect: true },
		{ operationId: "automate", action: "advance-automation" as const, projectId: "repo" },
		{ operationId: "read", action: "read-delivery-state" as const },
	])
		await expect(run("session", input)).rejects.toThrow();
	expect(await run("session", { operationId: "recover", recovery: "reconcile" })).toEqual({
		status: "missing",
	});
	await expect(
		run("foreign", { operationId: "foreign", action: "update-body", body: "No" }),
	).rejects.toThrow();
	expect(bodyWrites).toBe(0);
});

test("direct completed replay returns the original receipt before fresh remote reads", async () => {
	const run = host.agentSessions.runOperation;
	if (!run) throw new Error("Direct Issue tool unavailable");
	const input = { operationId: "replay-body", action: "update-body" as const, body: "Updated" };
	const result = await run("session", input);
	const reads = remoteReads;
	issueBody = "Later external edit";
	expect(
		await run("session", { body: "Updated", action: "update-body", operationId: "replay-body" }),
	).toEqual(result);
	expect(remoteReads).toBe(reads);
	expect(bodyWrites).toBe(1);
	for (const changed of [
		{ ...input, body: "Different" },
		{ ...input, action: "close-issue" as const, reason: "Done", acceptance: "Verified" },
		{ ...input, expectedSha: "different" },
	])
		await expect(run("session", changed)).rejects.toThrow("payload_changed");
	expect(bodyWrites).toBe(1);
});

test("direct uncertain replay never reads fresh facts or resends a dispatched write", async () => {
	const run = host.agentSessions.runOperation;
	if (!run) throw new Error("Direct Issue tool unavailable");
	const input = { operationId: "uncertain-body", action: "update-body" as const, body: "Updated" };
	failBodyWrite = true;
	await expect(run("session", input)).rejects.toThrow();
	expect(bodyWrites).toBe(1);
	const reads = remoteReads;
	failBodyWrite = false;
	await expect(run("session", input)).rejects.toThrow("uncertain_intent");
	await expect(run("session", { ...input, body: "Different" })).rejects.toThrow("payload_changed");
	expect(remoteReads).toBe(reads);
	expect(bodyWrites).toBe(1);
});

test("direct uncertain write reconciles exact observed success without another remote write", async () => {
	const run = host.agentSessions.runOperation;
	if (!run) throw new Error("Direct Issue tool unavailable");
	const input = { operationId: "reconcile-body", action: "update-body" as const, body: "Updated" };
	failBodyWrite = true;
	await expect(run("session", input)).rejects.toThrow();
	expect(bodyWrites).toBe(1);
	failBodyWrite = false;
	const recovered = await run("session", {
		operationId: input.operationId,
		recovery: "reconcile" as const,
	});
	expect(recovered).toMatchObject({ stage: "update-body", digest: expect.any(String) });
	expect(bodyWrites).toBe(1);
	expect(await run("session", input)).toEqual(recovered);
	expect(bodyWrites).toBe(1);
});

test("direct preparation failures never issue continuation cards or ask for fresh cards", async () => {
	const run = host.agentSessions.runOperation;
	if (!run) throw new Error("Direct Issue tool unavailable");
	try {
		await run("session", { operationId: "stage-refusal", report: "Implementation done" });
		throw new Error("Expected refusal");
	} catch (error) {
		expect(error).toHaveProperty("code", "ISSUE_CONFIRMATION_BLOCKED");
		expect(error).not.toHaveProperty("questions");
		expect(error).not.toHaveProperty("continuationId");
		expect(String(error)).not.toMatch(/card|questionnaire|refreshed confirmation/i);
	}
	expect(bodyWrites).toBe(0);
});
