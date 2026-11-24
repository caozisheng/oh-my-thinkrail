import { createHash } from "node:crypto";
import { isControlMessage } from "@thinkrail/contracts";

export type MatrixCommand =
	| { kind: "prompt" | "followup"; text: string }
	| { kind: "answer"; interactionId: string; text: string }
	| { kind: "stop" | "status" | "help" | "invalid" };

export function parseMatrixCommand(text: string): MatrixCommand {
	if (!text.startsWith("!omt")) return { kind: "prompt", text };
	if (text.startsWith("!omt say ")) return { kind: "prompt", text: text.slice(9) };
	if (text.startsWith("!omt followup ")) return { kind: "followup", text: text.slice(14) };
	const answer = /^!omt answer (\S+) ([\s\S]+)$/.exec(text);
	if (answer?.[1] && answer[2])
		return { kind: "answer", interactionId: answer[1], text: answer[2] };
	if (text === "!omt stop") return { kind: "stop" };
	if (text === "!omt status") return { kind: "status" };
	if (text === "!omt help") return { kind: "help" };
	return { kind: "invalid" };
}

export function transcriptProjection(message: unknown): string | null {
	if (!message || typeof message !== "object" || !("role" in message) || !("content" in message))
		return null;
	if (message.role !== "user" && message.role !== "assistant") return null;
	const content: unknown = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.flatMap((block: unknown) =>
							block &&
							typeof block === "object" &&
							"type" in block &&
							block.type === "text" &&
							"text" in block &&
							typeof block.text === "string"
								? [block.text]
								: [],
						)
						.join("\n")
				: "";
	if (!text.trim() || isControlMessage(text)) return null;
	return `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
}

export function projectionTransactionId(key: string): string {
	return `omt_${createHash("sha256").update(key).digest("hex")}`;
}
