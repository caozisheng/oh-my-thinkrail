import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { IssueReference } from "@thinkrail/contracts";
import { EN } from "@thinkrail/locales";
import { CodedError } from "@thinkrail/shared/codedError";
import type { IssueDeliveryRemote, IssueRecord } from "../issues";
import type { IssueConfirmationStore } from "./issueConfirmations";
import type { IssueSessionAssociation } from "./issueSessions";

interface Checkout {
	sha: string;
	branch: string;
	dirty: boolean;
}
export interface StagePayload {
	sessionId: string;
	reference: IssueReference;
	stage: "design" | "implementation";
	workflowTarget: "workflow::in-progress" | "workflow::in-review" | "workflow::done";
	normalizeWorkflowLabel: boolean;
	operationId: string;
	report: string;
	issueRevision: string;
	designOperationId: string | null;
	warnings?: string[];
	commits: {
		projectId: string;
		workspaceId: string;
		path: string;
		sha: string;
		branch: string;
		dirty?: boolean;
		target: string;
	}[];
}
function stop(reason = "stage-snapshot-changed"): never {
	throw new CodedError(
		"ISSUE_CONFIRMATION_BLOCKED",
		`Issue stage confirmation refused [${reason}]. Inspect the original operation with inspect:true. If no intent exists, prepare current facts and request a fresh card; use continueDespiteChecks:true for a warned policy exception. If a write may have been sent, inspect the remote result before recovery.`,
	);
}
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function revision(issue: IssueRecord): string {
	return digest({
		iid: issue.iid,
		title: issue.title,
		description: issue.description,
		state: issue.state,
		labels: issue.labels,
	});
}
function workflowLabel(labels: string[], target: StagePayload["workflowTarget"]): string[] {
	return [...labels.filter((label) => !label.startsWith("workflow::")), target];
}
function stageTarget(stage: StagePayload["stage"]): StagePayload["workflowTarget"] {
	return stage === "design" ? "workflow::in-progress" : "workflow::in-review";
}
export function stageQuestions(payload: StagePayload) {
	const design = payload.stage === "design";
	return {
		questions: [
			{
				question: payload.warnings?.length
					? "Continue with this stage operation despite the displayed check warnings?"
					: design
						? (EN["issue.confirm.design.question"] ?? "")
						: (EN["issue.confirm.implementation.question"] ?? ""),
				header: design
					? (EN["issue.confirm.design.header"] ?? "")
					: (EN["issue.confirm.implementation.header"] ?? ""),
				preview: `${payload.report}\n\nIssue: ${payload.reference.instanceUrl} / ${payload.reference.projectId} #${payload.reference.number}\nStage: ${payload.stage}\nWorkflow target: ${payload.workflowTarget}\nDesign operation: ${payload.designOperationId ?? payload.operationId}\n${payload.commits.map((commit) => `${commit.projectId}: ${commit.branch} @ ${commit.sha}`).join("\n")}${payload.warnings?.length ? `\n\nWarnings requiring explicit approval:\n${payload.warnings.map((warning) => `- ${warning}`).join("\n")}` : ""}\n\nConfirmation publishes this exact report and updates the workflow label. It does not authorize delivery.\nVersion: ${digest(payload)}`,
				options: [
					{
						label: "Looks right",
						description: EN["issue.confirm.stage.option"] ?? "",
					},
				],
			},
		],
	};
}
export interface IssueStageActionOptions {
	binding(sessionId: string): Promise<IssueSessionAssociation>;
	access(binding: IssueSessionAssociation): Promise<{
		remote: Pick<IssueDeliveryRemote, "issue" | "notes" | "addNote" | "updateIssue">;
		guard(): void;
	}>;
	repositories(binding: IssueSessionAssociation): Promise<
		readonly {
			projectId: string;
			workspaceId: string;
			name: string;
			path: string;
			role: "primary" | "associated";
		}[]
	>;
	checkout(repository: { projectId: string; workspaceId: string; path: string }): Promise<Checkout>;
	verifyAnswer(sessionId: string, payload: StagePayload, toolCallId: string): Promise<void>;
	journal: IssueConfirmationStore;
}
export function createIssueStageActions(options: IssueStageActionOptions) {
	async function hasMergedReceipt(reference: IssueReference): Promise<boolean> {
		return (await options.journal.listCompleted()).some((record) => {
			if (
				!record.payload ||
				typeof record.payload !== "object" ||
				!record.result ||
				typeof record.result !== "object"
			)
				return false;
			const value = record.payload as { stage?: string; reference?: IssueReference };
			const result = record.result as {
				stage?: string;
				mergeCommitSha?: string;
				targetSha?: string;
			};
			return (
				value.stage === "merge-mr" &&
				isDeepStrictEqual(value.reference, reference) &&
				result.stage === "merge-mr" &&
				typeof result.mergeCommitSha === "string" &&
				/^[a-fA-F0-9]{40}$/.test(result.mergeCommitSha) &&
				typeof result.targetSha === "string" &&
				/^[a-fA-F0-9]{40}$/.test(result.targetSha)
			);
		});
	}
	async function prepare(
		sessionId: string,
		input: {
			operationId: string;
			report: string;
			workflowTarget?: StagePayload["workflowTarget"];
			normalizeWorkflowLabel?: boolean;
			continueDespiteChecks?: boolean;
		},
	) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId) || !input.report.trim())
			stop();
		if (
			(input.normalizeWorkflowLabel !== undefined &&
				typeof input.normalizeWorkflowLabel !== "boolean") ||
			(input.workflowTarget !== undefined &&
				!["workflow::in-progress", "workflow::in-review", "workflow::done"].includes(
					input.workflowTarget,
				))
		)
			stop("workflow-target-invalid");
		const binding = await options.binding(sessionId);
		const { remote, guard } = await options.access(binding);
		const issue = await remote.issue(binding.reference.number);
		guard();
		if (issue.iid !== binding.reference.number) stop("issue-identity-mismatch");
		const workflowTarget = input.workflowTarget ?? stageTarget(binding.stage);
		if (
			(binding.stage === "design" && workflowTarget !== "workflow::in-progress") ||
			(binding.stage === "implementation" && workflowTarget === "workflow::in-progress")
		)
			stop("workflow-target-invalid-for-stage");
		if (workflowTarget === "workflow::done") {
			if (!(await hasMergedReceipt(binding.reference))) stop("verified-merge-required-for-done");
		}
		const warnings: string[] = [];
		if (workflowTarget !== "workflow::done" && issue.state !== "opened")
			warnings.push("Issue is closed; it will remain closed.");
		let designOperationId: string | null = null;
		if (binding.stage === "implementation" && workflowTarget !== "workflow::done") {
			const records = await options.journal.listCompleted();
			const design = records
				.filter((record) => {
					const value = record.payload as StagePayload;
					return value.stage === "design" && isDeepStrictEqual(value.reference, binding.reference);
				})
				.sort(
					(a, b) =>
						Number((b.result as { noteId: number }).noteId) -
						Number((a.result as { noteId: number }).noteId),
				)[0];
			if (!design || !(design.payload as StagePayload).report)
				warnings.push("No completed design receipt was found.");
			else designOperationId = design.operationId;
		}
		const workflow = issue.labels.filter((label) => label.startsWith("workflow::"));
		if (workflow.length > 1 && !input.normalizeWorkflowLabel)
			warnings.push("Issue has multiple workflow labels.");
		if (
			workflow.length > 1 ||
			(binding.stage === "design"
				? workflow[0] !== undefined && workflow[0] !== "workflow::backlog"
				: workflowTarget === "workflow::done"
					? workflow[0] !== "workflow::in-review"
					: workflow[0] !== "workflow::in-progress")
		) {
			if (!input.normalizeWorkflowLabel)
				warnings.push("Workflow label does not match the expected source stage.");
		}
		if (warnings.length && !input.continueDespiteChecks)
			throw new CodedError(
				"ISSUE_CONFIRMATION_BLOCKED",
				`${warnings[0]} Retry with continueDespiteChecks:true to prepare a warned confirmation.`,
			);
		const repositories =
			binding.stage === "implementation" && workflowTarget !== "workflow::done"
				? await options.repositories(binding)
				: [];
		guard();
		const commits = await Promise.all(
			repositories.map(async (repository) => {
				const state = await options.checkout(repository);
				guard();
				if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(state.sha) || !state.branch)
					stop("checkout-invalid");
				if (state.dirty) {
					if (!input.continueDespiteChecks)
						throw new CodedError(
							"ISSUE_CONFIRMATION_BLOCKED",
							"Checkout is dirty. Retry with continueDespiteChecks:true to prepare a warned confirmation.",
						);
					if (
						!warnings.includes(
							"Checkout is dirty; uncommitted changes are not part of the report's committed SHA.",
						)
					)
						warnings.push(
							"Checkout is dirty; uncommitted changes are not part of the report's committed SHA.",
						);
				}
				return {
					...repository,
					sha: state.sha,
					branch: state.branch,
					dirty: state.dirty,
					target: "",
				};
			}),
		);
		const payload: StagePayload = {
			sessionId,
			reference: binding.reference,
			stage: binding.stage,
			workflowTarget,
			normalizeWorkflowLabel: input.normalizeWorkflowLabel === true,
			operationId: input.operationId,
			report: input.report,
			issueRevision: revision(issue),
			designOperationId,
			warnings,
			commits,
		};
		const stored = await options.journal.prepare(sessionId, input.operationId, payload);
		return { digest: stored.digest, questions: stageQuestions(payload) };
	}
	async function execute(sessionId: string, operationId: string, toolCallId: string) {
		const stored = await options.journal.get(sessionId, operationId);
		if (!stored) stop();
		const payload = stored.payload as StagePayload;
		await options.verifyAnswer(sessionId, payload, toolCallId);
		const warnings = payload.warnings ?? [];
		async function preflight() {
			const binding = await options.binding(sessionId);
			if (payload.sessionId !== sessionId || payload.operationId !== operationId)
				stop("operation-binding-mismatch");
			if (binding.stage !== payload.stage) stop("session-stage-changed");
			if (!isDeepStrictEqual(binding.reference, payload.reference)) stop("issue-binding-changed");
			const { remote, guard } = await options.access(binding);
			const current = await remote.issue(payload.reference.number);
			guard();
			if (current.iid !== payload.reference.number) stop("issue-identity-mismatch");
			if (revision(current) !== payload.issueRevision) stop("issue-snapshot-changed");
			if (
				payload.workflowTarget === "workflow::done" &&
				!(await hasMergedReceipt(payload.reference))
			)
				stop("verified-merge-required-for-done");
			if (
				current.state !== "opened" &&
				payload.workflowTarget !== "workflow::done" &&
				!warnings.includes("Issue is closed; it will remain closed.")
			)
				stop();
			for (const commit of payload.commits) {
				const actual = await options.checkout(commit);
				guard();
				if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(actual.sha) || !actual.branch)
					stop("checkout-invalid");
				if (actual.sha !== commit.sha) stop("checkout-commit-changed");
				if (actual.branch !== commit.branch) stop("checkout-branch-changed");
				if (actual.dirty !== (commit.dirty ?? false)) stop("checkout-dirty-state-changed");
				if (
					actual.dirty &&
					!warnings.includes(
						"Checkout is dirty; uncommitted changes are not part of the report's committed SHA.",
					)
				)
					stop("checkout-dirty-without-approved-warning");
			}
			const labels = workflowLabel(
				current.labels,
				payload.workflowTarget ?? stageTarget(payload.stage),
			);
			return { remote, guard, current, labels };
		}
		let checked: Awaited<ReturnType<typeof preflight>> | undefined;
		let dispatched = false;
		return options.journal.execute(
			sessionId,
			operationId,
			stored.digest,
			toolCallId,
			async () => {
				if (!checked) stop();
				const { remote, guard, current, labels } = checked;
				dispatched = true;
				const note = await remote.addNote(payload.reference.number, payload.report);
				guard();
				const notes = await remote.notes(payload.reference.number);
				guard();
				if (
					!Number.isSafeInteger(note.id) ||
					!notes.some((entry) => entry.id === note.id && entry.body === payload.report)
				)
					stop();
				const beforeLabels = await remote.issue(payload.reference.number);
				guard();
				if (
					beforeLabels.description !== current.description ||
					beforeLabels.title !== current.title ||
					beforeLabels.state !== current.state ||
					!isDeepStrictEqual(beforeLabels.labels, current.labels)
				)
					stop();
				dispatched = true;
				await remote.updateIssue(payload.reference.number, { labels });
				guard();
				const updated = await remote.issue(payload.reference.number);
				guard();
				if (
					updated.state !== current.state ||
					!isDeepStrictEqual(updated.labels.toSorted(), labels.toSorted()) ||
					updated.description !== current.description
				)
					stop();
				return {
					stage: payload.stage,
					workflowTarget: payload.workflowTarget ?? stageTarget(payload.stage),
					noteId: note.id,
					digest: stored.digest,
				};
			},
			async () => {
				checked = await preflight();
			},
			() => dispatched,
		);
	}
	async function observe(sessionId: string, payload: StagePayload) {
		const binding = await options.binding(sessionId);
		if (!isDeepStrictEqual(binding.reference, payload.reference) || binding.stage !== payload.stage)
			stop("issue-binding-changed");
		const { remote, guard } = await options.access(binding);
		const issue = await remote.issue(payload.reference.number);
		guard();
		const workflow = issue.labels.filter((label) => label.startsWith("workflow::"));
		const expected = payload.workflowTarget ?? stageTarget(payload.stage);
		if (expected === "workflow::done" && !(await hasMergedReceipt(payload.reference)))
			stop("verified-merge-required-for-done");
		if (workflow.length !== 1 || workflow[0] !== expected) stop("recovery-labels-not-observed");
		const notes = await remote.notes(payload.reference.number);
		guard();
		const matching = notes.filter(
			(note) => note.body === payload.report && Number.isSafeInteger(note.id),
		);
		if (matching.length !== 1 || !matching[0]) stop("recovery-report-note-ambiguous-or-missing");
		return {
			evidence: {
				noteId: matching[0].id,
				labels: issue.labels.toSorted(),
				report: payload.report,
				issueRevision: revision(issue),
			},
			result: {
				stage: payload.stage,
				workflowTarget: expected,
				noteId: matching[0].id,
				digest: digest(payload),
			},
		};
	}
	return { prepare, execute, observe };
}
