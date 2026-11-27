import type { IssueReference } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import type {
	IssueDeliveryRepositoryState,
	IssueDeliveryStateRecord,
} from "./issueDeliveryStatePersistence";
import type { IssueSessionAssociation } from "./issueSessions";

export interface IssueDeliveryStateStore {
	load(projectId: string, reference: IssueReference): IssueDeliveryStateRecord | null;
	compareAndSet(
		projectId: string,
		reference: IssueReference,
		expectedRevision: number,
		next: IssueDeliveryStateRecord,
	): boolean;
}
function stop(reason: string, next?: unknown): never {
	throw new CodedError(
		"ISSUE_DELIVERY_REFUSED",
		`Issue delivery state refused [${reason}]${next ? `; refresh current state: ${JSON.stringify(next)}` : ""}.`,
	);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
export interface IssueDeliveryStateActionOptions {
	binding(sessionId: string): Promise<IssueSessionAssociation>;
	repositories(
		binding: IssueSessionAssociation,
	): Promise<readonly { projectId: string; workspaceId: string; path: string; name: string }[]>;
	checkout(repository: {
		projectId: string;
		workspaceId: string;
		path: string;
	}): Promise<{ sha: string; tree: string; branch: string; dirty: boolean }>;
	mergeRequest?(
		binding: IssueSessionAssociation,
		projectId: string,
		iid: number,
	): Promise<{
		iid: number;
		webUrl: string;
		headSha: string;
		targetBranch: string;
		sourceBranch: string;
		state: string;
	}>;
	store: IssueDeliveryStateStore;
}
export function createIssueDeliveryStateActions(options: IssueDeliveryStateActionOptions) {
	async function record(sessionId: string, expectedRevision: number, input: unknown) {
		const binding = await options.binding(sessionId);
		if (binding.stage !== "implementation") stop("session-stage-invalid");
		if (
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			!exact(input, ["repositories"]) ||
			!Array.isArray(input.repositories)
		)
			stop("input-invalid");
		const request = input as { repositories: unknown[] };
		const repositories = await options.repositories(binding);
		if (request.repositories.length !== repositories.length) stop("repository-set-mismatch");
		const previous = options.store.load(binding.projectId, binding.reference);
		const nextRepositories: IssueDeliveryRepositoryState[] = [];
		for (const value of request.repositories) {
			if (!value || typeof value !== "object" || Array.isArray(value)) stop("repository-invalid");
			const data = value as Record<string, unknown>;
			const repository = repositories.find((item) => item.projectId === data.projectId);
			if (!repository || nextRepositories.some((item) => item.projectId === repository.projectId))
				stop("repository-not-participating");
			const actual = await options.checkout(repository);
			if (
				data.worktreeId !== repository.workspaceId ||
				data.sourceBranch !== actual.branch ||
				data.checkoutSha !== actual.sha ||
				data.checkoutTree !== actual.tree
			)
				stop("checkout-snapshot-changed");
			const { mergeRequestId, ...metadata } = data;
			if (
				!exact(metadata, [
					"projectId",
					"worktreeId",
					"sourceBranch",
					"targetBranch",
					"policy",
					"dependsOn",
					"checkoutSha",
					"checkoutTree",
					"validations",
					"updatedAt",
				]) ||
				!["draft", "auto-merge", "manual"].includes(String(data.policy)) ||
				!Array.isArray(data.dependsOn) ||
				!Array.isArray(data.validations)
			)
				stop("repository-state-invalid");
			if (actual.dirty && data.validations.length) stop("validation-checkout-dirty");
			const validations = data.validations.map((entry) => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) stop("validation-invalid");
				const validation = entry as Record<string, unknown>;
				if (
					!exact(validation, [
						"command",
						"result",
						"sha",
						"tree",
						"targetBranch",
						"toolVersion",
						"platform",
						"observedAt",
					]) ||
					validation.sha !== actual.sha ||
					validation.tree !== actual.tree ||
					validation.targetBranch !== data.targetBranch ||
					![
						"passed",
						"failed",
						"skipped",
						"not-run",
						"not-applicable",
						"environment-limited",
					].includes(String(validation.result))
				)
					stop("validation-target-mismatch");
				return {
					...validation,
					sha: actual.sha,
					tree: actual.tree,
					source: "agent-reported" as const,
				};
			});
			const before = previous?.repositories.find((item) => item.projectId === repository.projectId);
			let mergeRequest =
				before?.sourceBranch === actual.branch && before.worktreeId === repository.workspaceId
					? before.mergeRequest
					: undefined;
			if (mergeRequestId !== undefined) {
				if (
					!Number.isSafeInteger(mergeRequestId) ||
					Number(mergeRequestId) <= 0 ||
					!options.mergeRequest
				)
					stop("merge-request-selector-invalid");
				const observed = await options.mergeRequest(
					binding,
					repository.projectId,
					Number(mergeRequestId),
				);
				if (
					observed.iid !== mergeRequestId ||
					observed.sourceBranch !== actual.branch ||
					(observed.state !== "merged" && observed.headSha !== actual.sha) ||
					observed.targetBranch !== data.targetBranch
				)
					stop("merge-request-checkout-mismatch");
				mergeRequest = {
					iid: observed.iid,
					webUrl: observed.webUrl,
					headSha: observed.headSha,
					targetBranch: observed.targetBranch,
					state: observed.state,
				};
			}
			if (
				(mergeRequest?.state !== "merged" && mergeRequest?.headSha !== actual.sha) ||
				mergeRequest?.targetBranch !== data.targetBranch
			)
				mergeRequest = undefined;
			nextRepositories.push({
				...(metadata as unknown as IssueDeliveryRepositoryState),
				...(mergeRequest ? { mergeRequest } : {}),
				checkoutSha: actual.sha,
				checkoutTree: actual.tree,
				validations: validations as unknown as IssueDeliveryRepositoryState["validations"],
			});
		}
		for (const repository of repositories) {
			const current = await options.checkout(repository);
			const saved = nextRepositories.find((item) => item.projectId === repository.projectId);
			if (
				!saved ||
				saved.sourceBranch !== current.branch ||
				saved.checkoutSha !== current.sha ||
				saved.checkoutTree !== current.tree ||
				(current.dirty && saved.validations.length)
			)
				stop("checkout-snapshot-changed");
		}
		const next = { revision: expectedRevision + 1, repositories: nextRepositories };
		if (options.store.compareAndSet(binding.projectId, binding.reference, expectedRevision, next))
			return next;
		const current = options.store.load(binding.projectId, binding.reference);
		stop("revision-conflict-refresh-and-retry", { revision: current?.revision ?? 0 });
	}
	async function read(sessionId: string) {
		const binding = await options.binding(sessionId);
		if (binding.stage !== "implementation") stop("session-stage-invalid");
		const current = options.store.load(binding.projectId, binding.reference) ?? {
			revision: 0,
			repositories: [],
		};
		const participating = await options.repositories(binding);
		const snapshots = await Promise.all(
			participating.map(async (repository) => ({
				projectId: repository.projectId,
				worktreeId: repository.workspaceId,
				...(await options.checkout(repository)),
			})),
		);
		return { ...current, participating: snapshots };
	}
	return { record, read };
}
