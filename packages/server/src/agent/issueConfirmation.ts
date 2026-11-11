import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@thinkrail/contracts";
import {
	assistantToolCallsAreExecutable,
	isToolResponsePending,
	readToolResponseMessage,
} from "@thinkrail/contracts";

interface MessageView {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
	toolCallId?: unknown;
	isError?: unknown;
	details?: unknown;
}

interface ToolCallView {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object";

function toolCalls(message: MessageView): ToolCallView[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.filter(
		(block): block is ToolCallView => isRecord(block) && block.type === "toolCall",
	);
}

function isConfirmationArgs(value: unknown): boolean {
	if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length !== 1)
		return false;
	const question = value.questions[0];
	if (
		!isRecord(question) ||
		(question.multiSelect !== undefined && question.multiSelect !== false) ||
		!Array.isArray(question.options)
	)
		return false;
	if (question.options.length !== 1) return false;
	const option = question.options[0];
	return isRecord(option) && option.label === "Looks right";
}

function isConfirmationResult(value: unknown, expectedQuestion: string): boolean {
	if (
		!isRecord(value) ||
		!Object.keys(value).every((key) => key === "cancelled" || key === "answers") ||
		value.cancelled !== false ||
		!Array.isArray(value.answers)
	)
		return false;
	if (value.answers.length !== 1) return false;
	const answer = value.answers[0];
	if (!isRecord(answer)) return false;
	return (
		Object.keys(answer).every((key) =>
			["questionIndex", "question", "kind", "answer", "notes"].includes(key),
		) &&
		answer.questionIndex === 0 &&
		answer.question === expectedQuestion &&
		answer.kind === "option" &&
		answer.answer === "Looks right" &&
		(answer.notes === undefined || answer.notes === "")
	);
}

/** Validate the host's exact, trusted questionnaire receipt before consuming an Issue action. */
export function isTrustedQuestionnaireReceipt(
	transcript: readonly AgentMessage[],
	toolCallId: string,
	expectedArgs: unknown,
): boolean {
	if (!isConfirmationArgs(expectedArgs)) return false;
	const expectedQuestion = (expectedArgs as { questions: [{ question: string }] }).questions[0]
		.question;
	if (typeof expectedQuestion !== "string") return false;

	const messages = transcript as readonly MessageView[];
	const allCalls = messages.flatMap(toolCalls);
	if (
		allCalls.some(
			(call) =>
				typeof call.id !== "string" ||
				allCalls.filter((other) => other.id === call.id).length !== 1,
		)
	)
		return false;
	const matchingCalls = messages.flatMap((message) =>
		toolCalls(message).filter(
			(call) => call.name === "ask_user_question" && call.id === toolCallId,
		),
	);
	if (matchingCalls.length !== 1) return false;
	const call = matchingCalls[0];
	if (!call || !isDeepStrictEqual(call.arguments, expectedArgs)) return false;
	const callIndex = messages.findIndex((message) => toolCalls(message).includes(call));
	if (
		callIndex < 0 ||
		!assistantToolCallsAreExecutable(messages[callIndex]?.stopReason as string | undefined)
	)
		return false;

	let receiptCount = 0;
	let receiptIndex = -1;
	for (let i = callIndex + 1; i < messages.length; i++) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "user" && receiptIndex < 0) return false;
		const custom = readToolResponseMessage(message);
		if (custom?.toolCallId === toolCallId) {
			receiptCount++;
			receiptIndex = i;
			if (!isConfirmationResult(custom.response, expectedQuestion)) return false;
		}
		if (message.role === "toolResult" && message.toolCallId === toolCallId) {
			if (message.isError === true) return false;
			// A persisted pending acknowledgement is neither an answer nor a rejection.
			if (isToolResponsePending(message.details)) continue;
			receiptCount++;
			receiptIndex = i;
			if (!isConfirmationResult(message.details, expectedQuestion)) return false;
		}
	}
	return receiptCount === 1 && receiptIndex >= callIndex;
}
