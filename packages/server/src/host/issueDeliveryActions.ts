import { isDeepStrictEqual } from "node:util";
import type { IssueReference } from "@thinkrail/contracts";
import { EN } from "@thinkrail/locales";
import { CodedError } from "@thinkrail/shared/codedError";
import type { IssueDeliveryRemote, IssueMergeRequest } from "../issues";
import type { IssueConfirmationStore } from "./issueConfirmations";
import type { IssueSessionAssociation } from "./issueSessions";

export interface DeliveryRepository {
	projectId: string;
	workspaceId: string;
	name: string;
	path: string;
	role: "primary" | "associated";
}
export interface DeliveryPayload {
	stage: "delivery";
	sessionId: string;
	operationId: string;
	reference: IssueReference;
	repository: DeliveryRepository;
	repositoryId: string;
	title: string;
	body: string;
	sha: string;
	branch: string;
	url: string;
	targetBranch: string;
	hostTargetBranch: string;
	issueSnapshot: unknown;
	existing: IssueMergeRequest | null;
}
export interface IssueDeliveryActionOptions {
	binding(sessionId: string): Promise<IssueSessionAssociation>;
	access(binding: IssueSessionAssociation): Promise<{ remote: IssueDeliveryRemote; guard(): void }>;
	repositories(binding: IssueSessionAssociation): Promise<readonly DeliveryRepository[]>;
	checkout(
		repository: DeliveryRepository,
	): Promise<{ sha: string; branch: string; dirty: boolean }>;
	repositoryRemote(repository: DeliveryRepository): Promise<{
		remote: IssueDeliveryRemote;
		repositoryId: string;
		url: string;
		targetBranch: string;
	}>;
	push(
		repository: DeliveryRepository,
		input: { sha: string; branch: string; url: string },
	): Promise<void>;
	verifyAnswer(sessionId: string, payload: DeliveryPayload, toolCallId: string): Promise<void>;
	journal: IssueConfirmationStore;
}
function stop(reason: string = "execution-snapshot-changed"): never {
	throw new CodedError(
		"ISSUE_DELIVERY_REFUSED",
		`Issue delivery refused [${reason}]. No automatic retry is authorized; journal reconciliation is a separate failure.`,
	);
}
function branch(value: string): boolean {
	return (
		!!value &&
		!/[\s~^:?*[\\]/.test(value) &&
		![...value].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) &&
		!value.startsWith("-") &&
		!value.startsWith("/") &&
		!value.endsWith("/") &&
		!value.endsWith(".") &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value.includes("//") &&
		value !== "@" &&
		!value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
	);
}
function validRequest(
	request: IssueMergeRequest,
	payload: Pick<DeliveryPayload, "repositoryId" | "branch" | "targetBranch" | "sha">,
	draft: boolean,
): void {
	let url: URL;
	try {
		url = new URL(request.webUrl);
	} catch {
		stop("existing-request-url-invalid");
	}
	if (request.sha !== payload.sha) stop("existing-request-sha-mismatch");
	if (
		!Number.isSafeInteger(request.id) ||
		request.id < 1 ||
		!Number.isSafeInteger(request.iid) ||
		request.iid < 1 ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		request.state !== "opened" ||
		request.sourceBranch !== payload.branch ||
		request.targetBranch !== payload.targetBranch ||
		request.sourceProjectId !== Number(payload.repositoryId) ||
		request.targetProjectId !== Number(payload.repositoryId) ||
		request.sha !== payload.sha ||
		(draft && request.draft !== true)
	)
		stop("existing-request-identity-invalid");
}
export function deliveryQuestions(payload: DeliveryPayload) {
	const action = payload.existing
		? `Reuse existing PR/MR #${payload.existing.iid}: ${payload.existing.webUrl}. No push or PR/MR modification.`
		: `Non-force push exact commit ${payload.sha} to ${payload.url}, branch ${payload.branch}; then create a draft PR/MR targeting ${payload.targetBranch}.`;
	return {
		questions: [
			{
				question: EN["issue.confirm.delivery.question"] ?? "",
				header: EN["issue.confirm.delivery.header"] ?? "",
				preview: `Issue: ${payload.reference.instanceUrl} / ${payload.reference.projectId} #${payload.reference.number}\nRepository: ${payload.repository.name} (${payload.repository.projectId})\nPath: ${payload.repository.path}\nSource: ${payload.branch} @ ${payload.sha}\nRemote: ${payload.url}\nTarget: ${payload.targetBranch}\nUncommitted workspace changes are excluded; only this exact commit will be delivered.\n\nTitle: ${payload.title}\n\n${payload.body}\n\n${action}\nNo merge or Issue closure is authorized.`,
				options: [{ label: "Looks right", description: EN["issue.confirm.delivery.option"] ?? "" }],
			},
		],
	};
}
export function createIssueDeliveryActions(options: IssueDeliveryActionOptions) {
	async function existing(
		remote: IssueDeliveryRemote,
		payload: Pick<DeliveryPayload, "repositoryId" | "branch" | "targetBranch" | "sha">,
	) {
		const requests = (await remote.mergeRequests(payload.branch)).filter(
			(request) =>
				request.sourceBranch === payload.branch && request.targetBranch === payload.targetBranch,
		);
		if (requests.length > 1) stop("existing-requests-ambiguous");
		const request = requests[0] ?? null;
		if (request) validRequest(request, payload, false);
		return request;
	}
	async function prepare(
		sessionId: string,
		input: {
			operationId: string;
			projectId: string;
			title: string;
			body: string;
			targetBranch?: string;
		},
	) {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId) ||
			!input.title.trim() ||
			!input.body.trim()
		)
			stop("input-invalid");
		const binding = await options.binding(sessionId);
		if (binding.sessionId !== sessionId) stop("session-mismatch");
		if (binding.stage !== "implementation") stop("session-not-implementation");
		const { remote, guard } = await options.access(binding);
		const repositories = await options.repositories(binding);
		guard();
		const selected = repositories.filter((repo) => repo.projectId === input.projectId);
		if (selected.length !== 1) stop("repository-not-participating");
		const repository = selected[0];
		if (!repository) stop("repository-not-participating");
		const state = await options.checkout(repository);
		guard();
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(state.sha)) stop("checkout-sha-invalid");
		if (!branch(state.branch)) stop("source-branch-invalid");
		const host = await options.repositoryRemote(repository);
		guard();
		const targetBranch = input.targetBranch ?? host.targetBranch;
		if (
			!/^[1-9][0-9]*$/.test(host.repositoryId) ||
			!Number.isSafeInteger(Number(host.repositoryId)) ||
			!host.url
		)
			stop("remote-identity-invalid");
		if (!branch(targetBranch)) stop("target-branch-invalid");
		if (targetBranch === state.branch) stop("target-equals-source");
		const issueSnapshot = await remote.issue(binding.reference.number);
		guard();
		if (issueSnapshot.iid !== binding.reference.number) stop("issue-identity-mismatch");
		if (issueSnapshot.state !== "opened") stop("issue-not-open");
		const payload: DeliveryPayload = {
			stage: "delivery",
			sessionId,
			operationId: input.operationId,
			reference: binding.reference,
			repository,
			repositoryId: host.repositoryId,
			title: input.title,
			body: input.body,
			sha: state.sha,
			branch: state.branch,
			url: host.url,
			targetBranch,
			hostTargetBranch: host.targetBranch,
			issueSnapshot,
			existing: null,
		};
		payload.existing = await existing(host.remote, payload);
		guard();
		const stored = await options.journal.prepare(sessionId, input.operationId, payload);
		return { digest: stored.digest, questions: deliveryQuestions(payload) };
	}
	async function execute(sessionId: string, operationId: string, toolCallId: string) {
		const stored = await options.journal.get(sessionId, operationId);
		if (!stored) stop();
		const payload = stored.payload as DeliveryPayload;
		if (
			payload.stage !== "delivery" ||
			payload.sessionId !== sessionId ||
			payload.operationId !== operationId
		)
			stop();
		await options.verifyAnswer(sessionId, payload, toolCallId);
		return options.journal.execute(sessionId, operationId, stored.digest, toolCallId, async () => {
			const binding = await options.binding(sessionId);
			if (
				binding.sessionId !== sessionId ||
				binding.stage !== "implementation" ||
				!isDeepStrictEqual(binding.reference, payload.reference)
			)
				stop();
			const { remote, guard } = await options.access(binding);
			async function revalidate() {
				const repositories = await options.repositories(binding);
				guard();
				const matches = repositories.filter(
					(repo) => repo.projectId === payload.repository.projectId,
				);
				if (matches.length !== 1 || !isDeepStrictEqual(matches[0], payload.repository)) stop();
				const state = await options.checkout(payload.repository);
				guard();
				if (state.sha !== payload.sha || state.branch !== payload.branch) stop();
				const issue = await remote.issue(payload.reference.number);
				guard();
				if (!isDeepStrictEqual(issue, payload.issueSnapshot)) stop();
				const host = await options.repositoryRemote(payload.repository);
				guard();
				if (
					host.repositoryId !== payload.repositoryId ||
					host.url !== payload.url ||
					host.targetBranch !== payload.hostTargetBranch
				)
					stop();
				return host.remote;
			}
			let delivery = await revalidate();
			const before = await existing(delivery, payload);
			guard();
			if (!isDeepStrictEqual(before, payload.existing)) stop();
			let request = before;
			if (!request) {
				await options.push(payload.repository, {
					sha: payload.sha,
					branch: payload.branch,
					url: payload.url,
				});
				guard();
				delivery = await revalidate();
				if (await existing(delivery, payload)) stop();
				guard();
				request = await delivery.createMergeRequest({
					sourceBranch: payload.branch,
					targetBranch: payload.targetBranch,
					title: payload.title,
					description: payload.body,
					draft: true,
				});
				guard();
				validRequest(request, payload, true);
				await revalidate();
			}
			return {
				stage: "delivery",
				projectId: payload.repository.projectId,
				sha: payload.sha,
				url: request.webUrl,
				number: request.iid,
				created: payload.existing === null,
			};
		});
	}
	return { prepare, execute };
}
