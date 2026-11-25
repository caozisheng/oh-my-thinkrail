import { createHash } from "node:crypto";
import { isControlMessage } from "@thinkrail/contracts";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

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

const matrixHtmlSchema: Parameters<typeof rehypeSanitize>[0] = {
	tagNames: [
		"a",
		"blockquote",
		"br",
		"code",
		"del",
		"em",
		"h1",
		"h2",
		"h3",
		"h4",
		"hr",
		"li",
		"ol",
		"p",
		"pre",
		"strong",
		"table",
		"tbody",
		"td",
		"th",
		"thead",
		"tr",
		"ul",
	],
	attributes: {
		a: ["href"],
		code: [["className", /^language-[a-zA-Z0-9_+-]+$/]],
	},
	protocols: { href: ["http", "https", "mailto"] },
};
const matrixMarkdownProcessor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype, {
		handlers: {
			html(_state, node) {
				return { type: "text", value: node.value };
			},
			image(_state, node) {
				return { type: "text", value: node.alt ?? "" };
			},
		},
	})
	.use(rehypeSanitize, matrixHtmlSchema)
	.use(rehypeStringify);

export interface MatrixFormattedText {
	body: string;
	formattedBody?: string;
}

/** Render untrusted agent Markdown to Matrix's safe custom HTML with a plain-text fallback. */
export async function renderMatrixMarkdown(markdown: string): Promise<MatrixFormattedText> {
	const body = markdown;
	const formattedBody = String(await matrixMarkdownProcessor.process(markdown));
	return formattedBody ? { body, formattedBody } : { body };
}

export async function matrixFormattedContent(prefix: string, markdown: string) {
	const rendered = await renderMatrixMarkdown(markdown);
	if (!rendered.formattedBody)
		return { msgtype: "m.notice" as const, body: `${prefix}${rendered.body}` };
	return {
		msgtype: "m.notice" as const,
		body: `${prefix}${rendered.body}`,
		format: "org.matrix.custom.html" as const,
		formatted_body: `${prefix ? `<p>${prefix.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>` : ""}${rendered.formattedBody}`,
	};
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
