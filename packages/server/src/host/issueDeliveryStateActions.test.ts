import { expect, test } from "bun:test";
import { createIssueDeliveryStateActions } from "./issueDeliveryStateActions";
import type { IssueDeliveryStateRecord } from "./issueDeliveryStatePersistence";

const binding = {
	sessionId: "s",
	projectId: "local",
	workspaceId: "ws",
	reference: {
		provider: "github" as const,
		instanceUrl: "https://github.com",
		projectId: "42",
		number: 1,
	},
	stage: "implementation" as const,
	locale: "en",
};
function state(sha = "a".repeat(40), tree = "b".repeat(40)) {
	return {
		projectId: "local",
		worktreeId: "ws",
		sourceBranch: "feature",
		targetBranch: "main",
		policy: "draft" as const,
		dependsOn: [],
		checkoutSha: sha,
		checkoutTree: tree,
		validations: [
			{
				command: "bun test",
				result: "passed" as const,
				sha,
				tree,
				targetBranch: "main",
				toolVersion: "bun",
				platform: "win32",
				observedAt: "2026-11-13T00:00:00Z",
			},
		],
		updatedAt: "2026-11-13T00:00:00Z",
	};
}
test("state recording requires an implementation binding and the host-observed exact checkout", async () => {
	let saved: IssueDeliveryStateRecord | null = null;
	const actions = createIssueDeliveryStateActions({
		binding: async () => binding,
		repositories: async () => [
			{ projectId: "local", workspaceId: "ws", path: "/repo", name: "Repo" },
		],
		checkout: async () => ({
			sha: "a".repeat(40),
			tree: "b".repeat(40),
			branch: "feature",
			dirty: false,
		}),
		store: {
			load: () => saved,
			compareAndSet: (_id, _ref, revision, next) => {
				if ((saved?.revision ?? 0) !== revision) return false;
				saved = next;
				return true;
			},
		},
	});
	await expect(actions.record("s", 0, { repositories: [state()] })).resolves.toMatchObject({
		revision: 1,
	});
	await expect(
		actions.record("s", 1, {
			repositories: [{ ...state("c".repeat(40)), checkoutSha: "c".repeat(40) }],
		}),
	).rejects.toThrow("checkout-snapshot-changed");
});

test("CAS conflict refuses rather than overwriting concurrent delivery decisions", async () => {
	const actions = createIssueDeliveryStateActions({
		binding: async () => binding,
		repositories: async () => [
			{ projectId: "local", workspaceId: "ws", path: "/repo", name: "Repo" },
		],
		checkout: async () => ({
			sha: "a".repeat(40),
			tree: "b".repeat(40),
			branch: "feature",
			dirty: false,
		}),
		store: { load: () => null, compareAndSet: () => false },
	});
	await expect(actions.record("s", 0, { repositories: [state()] })).rejects.toThrow(
		"revision-conflict-refresh-and-retry",
	);
});

test("state reads expose checkout snapshots and MR selectors are verified and preserved", async () => {
	let saved: IssueDeliveryStateRecord | null = null;
	let branch = "feature";
	const actions = createIssueDeliveryStateActions({
		binding: async () => binding,
		repositories: async () => [
			{ projectId: "local", workspaceId: "ws", path: "/repo", name: "Repo" },
		],
		checkout: async () => ({
			sha: "a".repeat(40),
			tree: "b".repeat(40),
			branch,
			dirty: false,
		}),
		mergeRequest: async (_binding, _projectId, iid) => ({
			iid,
			webUrl: "https://github.com/o/r/pull/1",
			headSha: "a".repeat(40),
			targetBranch: "main",
			sourceBranch: "feature",
			state: "merged",
		}),
		store: {
			load: () => saved,
			compareAndSet: (_id, _ref, rev, next) => {
				if ((saved?.revision ?? 0) !== rev) return false;
				saved = next;
				return true;
			},
		},
	});
	expect(await actions.read("s")).toMatchObject({
		revision: 0,
		participating: [{ projectId: "local", worktreeId: "ws", sha: "a".repeat(40) }],
	});
	const first = await actions.record("s", 0, { repositories: [{ ...state(), mergeRequestId: 1 }] });
	expect(first.repositories[0]?.mergeRequest).toMatchObject({ iid: 1, state: "merged" });
	const refreshed = await actions.record("s", 1, { repositories: [state()] });
	expect(refreshed.repositories[0]?.mergeRequest).toMatchObject({ iid: 1 });
	branch = "another-feature";
	const switched = await actions.record("s", 2, {
		repositories: [{ ...state(), sourceBranch: branch }],
	});
	expect(switched.repositories[0]?.mergeRequest).toBeUndefined();
	await expect(
		actions.record("s", 3, {
			repositories: [{ ...state(), sourceBranch: branch, mergeRequest: { iid: 9 } }],
		}),
	).rejects.toThrow("repository-state-invalid");
});
