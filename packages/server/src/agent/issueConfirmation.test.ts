import { expect, test } from "bun:test";
import type { AgentMessage } from "@thinkrail/contracts";
import { isTrustedQuestionnaireReceipt } from "./issueConfirmation";

const args = {
	questions: [{ question: "Use this design?", header: "Design", options: [{ label: "Looks right", description: "Confirm" }] }],
};
const call = (id = "call-1", stopReason = "toolUse") => ({
	role: "assistant",
	stopReason,
	content: [{ type: "toolCall", id, name: "ask_user_question", arguments: args }],
});
const result = {
	cancelled: false,
	answers: [{ questionIndex: 0, question: "Use this design?", kind: "option", answer: "Looks right" }],
};
const receipt = (isError = false) => ({ role: "toolResult", toolCallId: "call-1", isError, details: result });
const valid = (...messages: unknown[]) =>
	isTrustedQuestionnaireReceipt(messages as AgentMessage[], "call-1", args);

test("accepts an exact executable questionnaire and successful answer receipt", () => {
	expect(valid(call(), receipt())).toBe(true);
	expect(valid(call(), { role: "custom", customType: "tool-response", details: { toolCallId: "call-1", response: result } })).toBe(true);
	expect(valid(call(), receipt(), { role: "user", content: "next turn" })).toBe(true);
});

test("rejects altered, ambiguous, unsuccessful, pending, or superseded receipts", () => {
	expect(valid(call(), { ...receipt(), details: { kind: "ack" } })).toBe(false);
	expect(valid(call(), receipt(true))).toBe(false);
	expect(valid(call("call-1", "error"), receipt())).toBe(false);
	expect(valid(call(), { role: "user", content: "superseded" }, receipt())).toBe(false);
	expect(valid(call(), receipt(), receipt())).toBe(false);
	expect(valid(call(), receipt(), call())).toBe(false);
	expect(valid(call(), { ...receipt(), details: { ...result, answers: [{ ...result.answers[0], notes: "extra" }] } })).toBe(false);
	expect(valid(call(), { ...receipt(), details: { ...result, answers: [result.answers[0], result.answers[0]] } })).toBe(false);
	expect(valid(call(), receipt(), { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "other", arguments: {} }], stopReason: "toolUse" })).toBe(false);
});
