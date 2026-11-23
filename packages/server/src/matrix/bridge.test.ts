import { expect, test } from "bun:test";
import { parseMatrixCommand, transcriptProjection } from "./bridge";

test("explicit commands never silently become prompts", () => {
	expect(parseMatrixCommand("hello")).toEqual({ kind: "prompt", text: "hello" });
	expect(parseMatrixCommand("!omt followup later")).toEqual({ kind: "followup", text: "later" });
	expect(parseMatrixCommand("!omt say !omt stop")).toEqual({ kind: "prompt", text: "!omt stop" });
	expect(parseMatrixCommand("!omt typo")).toEqual({ kind: "invalid" });
	expect(parseMatrixCommand("!omt stop")).toEqual({ kind: "stop" });
	expect(parseMatrixCommand("!omt answer interaction-7 2;text:custom")).toEqual({ kind: "answer", interactionId: "interaction-7", text: "2;text:custom" });
});

test("transcript projections exclude thinking, tool data and control messages", () => {
	expect(
		transcriptProjection({
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "answer" },
			],
		}),
	).toBe("Assistant: answer");
	expect(
		transcriptProjection({
			role: "toolResult",
			content: [{ type: "text", text: "private tool output" }],
		}),
	).toBeNull();
	expect(transcriptProjection({ role: "user", content: "hello" })).toBe("User: hello");
});
