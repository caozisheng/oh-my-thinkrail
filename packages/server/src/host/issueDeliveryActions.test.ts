import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueDeliveryRemote, IssueMergeRequest } from "../issues";
import { createIssueConfirmationStore } from "./issueConfirmations";
import { createIssueDeliveryActions, type DeliveryPayload } from "./issueDeliveryActions";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "issue-delivery-"));
	roots.push(root);
	const journal = createIssueConfirmationStore(root);
	const reference = {
		provider: "github" as const,
		instanceUrl: "https://github.com",
		projectId: "123",
		number: 38,
	};
	const binding = {
		sessionId: "session",
		projectId: "primary",
		workspaceId: "primary-workspace",
		reference,
		stage: "implementation" as "implementation" | "design",
		locale: "en",
	};
	const repository = {
		projectId: "associated",
		workspaceId: "associated-workspace",
		path: "/associated",
		name: "Associated",
		role: "associated" as const,
	};
	const state = { sha: "a".repeat(40), branch: "feature/38", dirty: false };
	const host = {
		repositoryId: "456",
		url: "https://github.com/owner/associated.git",
		targetBranch: "develop",
	};
	const issue = {
		iid: 38,
		title: "Issue",
		description: "Description",
		state: "opened" as const,
		labels: ["workflow::in-review"],
		updatedAt: "1",
	};
	let requests: IssueMergeRequest[] = [];
	let answered = false;
	let failCreate = false;
	let createdOverrides: Partial<IssueMergeRequest> = {};
	let race = false;
	const effects: unknown[] = [];
	const request = (): IssueMergeRequest => ({
		id: 91,
		iid: 9,
		webUrl: "https://github.com/owner/associated/pull/9",
		state: "opened",
		sourceBranch: "feature/38",
		targetBranch: "develop",
		sha: "a".repeat(40),
		draft: true,
		sourceProjectId: 456,
		targetProjectId: 456,
		mergeStatus: "unknown",
		detailedMergeStatus: null,
		mergeCommitSha: null,
		squashCommitSha: null,
		headPipeline: null,
	});
	const remote: IssueDeliveryRemote = {
		provider: "github",
		project: async () => ({
			id: 456,
			pathWithNamespace: "owner/associated",
			defaultBranch: "develop",
			httpUrlToRepo: host.url,
			sshUrlToRepo: null,
		}),
		issue: async () => structuredClone(issue),
		issues: async () => [],
		notes: async () => [],
		addNote: async () => {
			throw new Error("Unexpected comment");
		},
		updateIssue: async () => {
			throw new Error("Unexpected Issue update");
		},
		mergeRequests: async () => structuredClone(requests),
		createMergeRequest: async (input) => {
			effects.push(input);
			if (failCreate) throw new Error("uncertain create");
			return { ...request(), ...createdOverrides };
		},
	};
	const actions = createIssueDeliveryActions({
		binding: async () => structuredClone(binding),
		access: async () => ({ remote, guard: () => {} }),
		repositories: async () => [structuredClone(repository)],
		checkout: async () => structuredClone(state),
		repositoryRemote: async () => ({ ...host, remote }),
		push: async (repo, input) => {
			effects.push({ repository: repo.projectId, ...input });
			if (race) requests = [request()];
		},
		verifyAnswer: async (_sessionId, _payload: DeliveryPayload, toolCallId) => {
			if (!answered || toolCallId !== "answer") throw new Error("Unverified answer");
		},
		journal,
	});
	const prepare = (targetBranch?: string) =>
		actions.prepare("session", {
			operationId: "deliver",
			projectId: "associated",
			title: "Deliver exact title",
			body: "Exact draft body",
			...(targetBranch === undefined ? {} : { targetBranch }),
		});
	return {
		actions,
		journal,
		prepare,
		effects,
		binding,
		repository,
		state,
		host,
		issue,
		request,
		approve: () => {
			answered = true;
		},
		setRequests: (value: IssueMergeRequest[]) => {
			requests = value;
		},
		fail: () => {
			failCreate = true;
		},
		invalid: () => {
			createdOverrides = { draft: false };
		},
		created: (overrides: Partial<IssueMergeRequest>) => {
			createdOverrides = overrides;
		},
		race: () => {
			race = true;
		},
	};
}

test("delivery needs no prior implementation receipt and pushes the reviewed current SHA", async () => {
	const f = await fixture();
	const card = await f.prepare();
	expect(card.questions.questions[0]?.options).toEqual([
		{ label: "Looks right", description: expect.any(String) },
	]);
	const preview = card.questions.questions[0]?.preview;
	for (const text of ["Exact draft body", f.state.sha, f.host.url, "develop", "Non-force push"])
		expect(preview).toContain(text);
	await expect(f.actions.execute("session", "deliver", "answer")).rejects.toThrow();
	expect(f.effects).toEqual([]);
	f.approve();
	expect(await f.actions.execute("session", "deliver", "answer")).toEqual({
		stage: "delivery",
		projectId: "associated",
		sha: f.state.sha,
		url: f.request().webUrl,
		number: 9,
		created: true,
	});
	expect(f.effects).toEqual([
		{ repository: "associated", sha: f.state.sha, branch: f.state.branch, url: f.host.url },
		{
			sourceBranch: f.state.branch,
			targetBranch: "develop",
			title: "Deliver exact title",
			description: "Exact draft body",
			draft: true,
		},
	]);
	await f.actions.execute("session", "deliver", "answer");
	expect(f.effects).toHaveLength(2);
});

test("historical implementation commits do not block review of the current checkout", async () => {
	const f = await fixture();
	const old = await f.journal.prepare("old-session", "old-implementation", {
		stage: "implementation",
		report: "Earlier implementation",
		commits: [{ ...f.repository, sha: "b".repeat(40), branch: "old-branch" }],
	});
	await f.journal.execute(
		"old-session",
		"old-implementation",
		old.digest,
		"old-answer",
		async () => ({
			stage: "implementation",
			noteId: 7,
		}),
	);
	const card = await f.prepare();
	expect(card.questions.questions[0]?.preview).toContain(f.state.sha);
	expect(card.questions.questions[0]?.preview).toContain(f.state.branch);
	expect(f.effects).toEqual([]);
});

test("one exact existing PR is reused without push or modification", async () => {
	const f = await fixture();
	f.setRequests([f.request()]);
	expect((await f.prepare()).questions.questions[0]?.preview).toContain("Reuse existing");
	f.approve();
	expect(await f.actions.execute("session", "deliver", "answer")).toMatchObject({
		created: false,
		number: 9,
	});
	expect(f.effects).toEqual([]);
});

test("prepare refuses design stage, invalid SHA and missing default", async () => {
	for (const mutate of [
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.binding.stage = "design";
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.state.sha = "a".repeat(41);
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.host.targetBranch = "";
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.host.targetBranch = f.state.branch;
		},
	]) {
		const f = await fixture();
		mutate(f);
		await expect(f.prepare()).rejects.toThrow();
		expect(f.effects).toEqual([]);
	}
});

test("prepare identifies checkout and existing-request refusals without exposing private data", async () => {
	for (const [reason, mutate] of [
		[
			"source-branch-invalid",
			(f: Awaited<ReturnType<typeof fixture>>) => {
				f.state.branch = "";
			},
		],
		[
			"target-equals-source",
			(f: Awaited<ReturnType<typeof fixture>>) => {
				f.host.targetBranch = f.state.branch;
			},
		],
		[
			"existing-request-sha-mismatch",
			(f: Awaited<ReturnType<typeof fixture>>) => {
				f.setRequests([{ ...f.request(), sha: "b".repeat(40) }]);
			},
		],
	] as const) {
		const f = await fixture();
		mutate(f);
		await expect(f.prepare()).rejects.toMatchObject({
			code: "ISSUE_DELIVERY_REFUSED",
			message: expect.stringContaining(`[${reason}]`),
		});
		expect(f.effects).toEqual([]);
	}
});

test("local edits do not block authorization or change the pushed commit", async () => {
	const f = await fixture();
	f.state.dirty = true;
	const card = await f.prepare();
	expect(card.questions.questions[0]?.preview).toContain(
		"Uncommitted workspace changes are excluded",
	);
	f.state.dirty = false;
	f.approve();
	await f.actions.execute("session", "deliver", "answer");
	expect(f.effects[0]).toMatchObject({ sha: f.state.sha, branch: f.state.branch });
});

test("local edits made after review do not invalidate the committed snapshot", async () => {
	const f = await fixture();
	await f.prepare();
	f.state.dirty = true;
	f.approve();
	await f.actions.execute("session", "deliver", "answer");
	expect(f.effects).toHaveLength(2);
});

test("explicit target is frozen instead of guessing main", async () => {
	const f = await fixture();
	f.host.targetBranch = "";
	expect((await f.prepare("release")).questions.questions[0]?.preview).toContain("Target: release");
});

test("ambiguous, stale or closed existing PRs fail closed", async () => {
	for (const requests of [
		(f: Awaited<ReturnType<typeof fixture>>) => [f.request(), { ...f.request(), iid: 10 }],
		(f: Awaited<ReturnType<typeof fixture>>) => [{ ...f.request(), sha: "b".repeat(40) }],
		(f: Awaited<ReturnType<typeof fixture>>) => [{ ...f.request(), state: "closed" as const }],
	]) {
		const f = await fixture();
		f.setRequests(requests(f));
		await expect(f.prepare()).rejects.toThrow();
		expect(f.effects).toEqual([]);
	}
});

test("changed checkout, repository path, remote identity, target or Issue invalidates execution before push", async () => {
	for (const mutate of [
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.state.sha = "b".repeat(40);
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.state.branch = "other";
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.repository.path = "/replaced";
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.host.repositoryId = "789";
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.host.url += "replaced";
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.host.targetBranch = "release";
		},
		(f: Awaited<ReturnType<typeof fixture>>) => {
			f.issue.updatedAt = "2";
		},
	]) {
		const f = await fixture();
		await f.prepare();
		f.approve();
		mutate(f);
		await expect(f.actions.execute("session", "deliver", "answer")).rejects.toThrow();
		expect(f.effects).toEqual([]);
	}
});

test("a PR appearing after confirmation is never adopted", async () => {
	const f = await fixture();
	await f.prepare();
	f.approve();
	f.setRequests([f.request()]);
	await expect(f.actions.execute("session", "deliver", "answer")).rejects.toThrow();
	expect(f.effects).toEqual([]);
});

test("post-push failure, malformed draft response and concurrent PR retain pending reservation with no replay", async () => {
	for (const mode of ["fail", "invalid", "race"] as const) {
		const f = await fixture();
		await f.prepare();
		f.approve();
		f[mode]();
		await expect(f.actions.execute("session", "deliver", "answer")).rejects.toThrow();
		const count = f.effects.length;
		expect(count).toBeGreaterThan(0);
		await expect(f.actions.execute("session", "deliver", "answer")).rejects.toThrow();
		expect(f.effects).toHaveLength(count);
		expect(
			(await f.journal.listCompleted()).filter((entry) => entry.operationId === "deliver"),
		).toEqual([]);
		await expect(f.journal.prepare("session", "another", {})).rejects.toThrow();
	}
});

test("created PR identity, branches, SHA and draft flag must match the frozen request", async () => {
	for (const overrides of [
		{ id: 0 },
		{ iid: 0 },
		{ sourceBranch: "other" },
		{ targetBranch: "other" },
		{ sha: "b".repeat(40) },
		{ sha: "a".repeat(7) },
		{ sha: null },
		{ sourceProjectId: 789 },
		{ sourceProjectId: null },
		{ targetProjectId: 789 },
		{ targetProjectId: null },
		{ draft: null },
		{ state: "closed" as const },
		{ webUrl: "https://secret@example.com/pull/9" },
	]) {
		const f = await fixture();
		await f.prepare();
		f.approve();
		f.created(overrides);
		await expect(f.actions.execute("session", "deliver", "answer")).rejects.toThrow();
		expect(f.effects).toHaveLength(2);
		await expect(f.actions.execute("session", "deliver", "answer")).rejects.toThrow();
		expect(f.effects).toHaveLength(2);
	}
});

test("existing same-branch fork, unknown repository IDs and inexact SHA fail closed", async () => {
	for (const overrides of [
		{ sourceProjectId: 789 },
		{ sourceProjectId: null },
		{ targetProjectId: 789 },
		{ targetProjectId: null },
		{ sha: null },
		{ sha: "a".repeat(7) },
	]) {
		const f = await fixture();
		f.setRequests([{ ...f.request(), ...overrides }]);
		await expect(f.prepare()).rejects.toThrow();
		expect(f.effects).toEqual([]);
	}
});

test("authenticated repository identity is numeric and frozen in the delivery payload", async () => {
	const f = await fixture();
	await f.prepare();
	expect((await f.journal.get("session", "deliver"))?.payload).toMatchObject({
		repositoryId: "456",
	});
	for (const repositoryId of ["", "associated", "0", "-1", "1.5", "0456", "9007199254740992"]) {
		const invalid = await fixture();
		invalid.host.repositoryId = repositoryId;
		await expect(invalid.prepare()).rejects.toThrow();
		expect(invalid.effects).toEqual([]);
	}
});
