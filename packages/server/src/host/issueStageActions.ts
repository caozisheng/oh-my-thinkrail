import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { IssueReference } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import type { IssueDeliveryRemote, IssueRecord } from "../issues/remote";
import type { IssueConfirmationStore } from "./issueConfirmations";
import type { IssueSessionAssociation } from "./issueSessions";

interface Checkout { sha: string; branch: string; dirty: boolean }
export interface StagePayload {
	sessionId: string;
	reference: IssueReference;
	stage: "design" | "implementation";
	operationId: string;
	report: string;
	issueRevision: string;
	designOperationId: string | null;
	commits: { projectId: string; workspaceId: string; path: string; sha: string; branch: string; target: string }[];
}
function stop(): never { throw new CodedError("RESOURCE_UNAVAILABLE", "Issue confirmation is stale or requires reconciliation."); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function revision(issue: IssueRecord): string { return digest({ iid: issue.iid, title: issue.title, description: issue.description, state: issue.state, labels: issue.labels, updatedAt: issue.updatedAt }); }
function workflowLabel(labels: string[], expected: string): string[] {
	const workflow = labels.filter((label) => label.startsWith("workflow::"));
	if (workflow.some((label) => !["workflow::in-progress", "workflow::in-review", "workflow::done"].includes(label)) || workflow.length > 1) stop();
	return [...labels.filter((label) => !label.startsWith("workflow::")), expected];
}
export function stageQuestions(payload: StagePayload) {
	const design = payload.stage === "design";
	return { questions: [{
		question: design ? "Confirm this design and publish it to the Issue?" : "Confirm this implementation report and move the Issue to review?",
		header: design ? "Design" : "Implementation",
		preview: `${payload.report}\n\nIssue: ${payload.reference.instanceUrl} / ${payload.reference.projectId} #${payload.reference.number}\nStage: ${payload.stage}\nDesign operation: ${payload.designOperationId ?? payload.operationId}\n${payload.commits.map((commit) => `${commit.projectId}: ${commit.branch} @ ${commit.sha}`).join("\n")}\n\nConfirmation publishes this exact report and updates the workflow label. It does not authorize delivery.\nVersion: ${digest(payload)}`,
		options: [{ label: "Looks right", description: "Publish the displayed report and update this Issue stage." }],
	}] };
}
export interface IssueStageActionOptions {
	binding(sessionId: string): Promise<IssueSessionAssociation>;
	access(binding: IssueSessionAssociation): Promise<{ remote: IssueDeliveryRemote; guard(): void }>;
	repositories(binding: IssueSessionAssociation): Promise<readonly { projectId: string; workspaceId: string; name: string; path: string; role: "primary" | "associated" }[]>;
	checkout(repository: { projectId: string; workspaceId: string; path: string }): Promise<Checkout>;
	verifyAnswer(sessionId: string, payload: StagePayload, toolCallId: string): Promise<void>;
	journal: IssueConfirmationStore;
}

export function createIssueStageActions(options: IssueStageActionOptions) {
	async function prepare(sessionId: string, input: { operationId: string; report: string }) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId) || !input.report.trim()) stop();
		const binding = await options.binding(sessionId);
		const { remote, guard } = await options.access(binding);
		const issue = await remote.issue(binding.reference.number); guard();
		if (issue.state !== "opened" || issue.iid !== binding.reference.number) stop();
		let designOperationId: string | null = null;
		if (binding.stage === "implementation") {
			const records = await options.journal.listCompleted();
			const design = records.filter((record) => { const value = record.payload as StagePayload; return value.stage === "design" && isDeepStrictEqual(value.reference, binding.reference); }).sort((a, b) => Number((b.result as { noteId: number }).noteId) - Number((a.result as { noteId: number }).noteId))[0];
			if (!design || !(design.payload as StagePayload).report) stop();
			designOperationId = design.operationId;
		}
		const repositories = await options.repositories(binding); guard();
		const commits = await Promise.all(repositories.map(async (repository) => {
			const state = await options.checkout(repository); guard();
			if (state.dirty || !/^[a-f0-9]{40,64}$/.test(state.sha) || !state.branch) stop();
			return { ...repository, sha: state.sha, branch: state.branch, target: "" };
		}));
		const payload: StagePayload = { sessionId, reference: binding.reference, stage: binding.stage, operationId: input.operationId, report: input.report, issueRevision: revision(issue), designOperationId, commits };
		const stored = await options.journal.prepare(sessionId, input.operationId, payload);
		return { digest: stored.digest, questions: stageQuestions(payload) };
	}
	async function execute(sessionId: string, operationId: string, toolCallId: string) {
		const stored = await options.journal.get(sessionId, operationId);
		if (!stored) stop();
		const payload = stored.payload as StagePayload;
		await options.verifyAnswer(sessionId, payload, toolCallId);
		return options.journal.execute(sessionId, operationId, stored.digest, toolCallId, async () => {
			const binding = await options.binding(sessionId);
			if (binding.stage !== payload.stage || !isDeepStrictEqual(binding.reference, payload.reference)) stop();
			const { remote, guard } = await options.access(binding);
			const current = await remote.issue(payload.reference.number); guard();
			if (revision(current) !== payload.issueRevision || current.state !== "opened") stop();
			for (const commit of payload.commits) {
				const actual = await options.checkout(commit); guard();
				if (actual.sha !== commit.sha || actual.branch !== commit.branch || actual.dirty) stop();
			}
			const note = await remote.addNote(payload.reference.number, payload.report); guard();
			const stage = payload.stage === "design" ? "workflow::in-progress" : "workflow::in-review";
			await remote.updateIssue(payload.reference.number, { labels: workflowLabel(current.labels, stage) }); guard();
			return { stage: payload.stage, noteId: note.id, digest: stored.digest };
		});
	}
	return { prepare, execute };
}
