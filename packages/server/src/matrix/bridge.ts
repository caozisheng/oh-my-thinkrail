import { createHash } from "node:crypto";
import { isControlMessage } from "@thinkrail/contracts";
import type { Options as MatrixSanitizeSchema } from "rehype-sanitize";
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

const matrixHtmlSchema: MatrixSanitizeSchema = {
	ancestors: {},
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
		ol: [["start", /^\d+$/]],
	},
	clobber: [],
	clobberPrefix: "matrix-content-",
	protocols: { href: ["http", "https", "mailto"] },
};
export const MATRIX_STREAM_CHUNK_MAX_BYTES = 10_000;
export const MATRIX_EVENT_CONTENT_MAX_BYTES = 60_000;
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
			imageReference(_state, node) {
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

export interface MatrixMessageContent {
	msgtype: "m.notice";
	body: string;
	format?: "org.matrix.custom.html";
	formatted_body?: string;
}

/** Render untrusted agent Markdown to Matrix's safe custom HTML with a plain-text fallback. */
export async function renderMatrixMarkdown(markdown: string): Promise<MatrixFormattedText> {
	const body = markdown;
	try {
		const formattedBody = String(await matrixMarkdownProcessor.process(markdown));
		return { body, formattedBody };
	} catch {
		return { body };
	}
}

export function isMarkdownContinuation(text: string, offset: number) {
	const prefix = /^(?:Assistant|User): /.exec(text)?.[0] ?? "";
	if (offset <= prefix.length) return false;
	let open: { marker: string; length: number } | undefined;
	let start = prefix.length;
	while (start < offset && start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline;
		const line = text.slice(start, end);
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const fence = match?.[1];
		const complete = end <= offset;
		if (fence) {
			const info = match[2] ?? "";
			if (open) {
				if (
					complete &&
					fence[0] === open.marker &&
					fence.length >= open.length &&
					info.trim() === ""
				)
					open = undefined;
			} else if (
				(fence[0] !== "`" || !info.includes("`")) &&
				offset > start + line.indexOf(fence)
			) {
				open = { marker: fence.charAt(0), length: fence.length };
			}
		}
		if (newline < 0 || end >= offset) break;
		start = end + 1;
	}
	return open !== undefined;
}

export async function matrixFormattedContent(
	prefix: string,
	markdown: string,
	options: { allowFormatted?: boolean } = {},
): Promise<MatrixMessageContent> {
	const plain = `${prefix}${markdown}`;
	const plainContent = { msgtype: "m.notice" as const, body: plain };
	if (options.allowFormatted === false) return plainContent;
	if (Buffer.byteLength(JSON.stringify(plainContent)) > MATRIX_EVENT_CONTENT_MAX_BYTES)
		throw new Error("Matrix event content exceeds size limit");
	const rendered = await renderMatrixMarkdown(markdown);
	if (!rendered.formattedBody) return plainContent;
	const prefixHtml = prefix
		? `<p>${prefix.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`
		: "";
	const formattedBody = `${prefixHtml}${rendered.formattedBody}`;
	const formatted = {
		...plainContent,
		format: "org.matrix.custom.html" as const,
		formatted_body: formattedBody,
	};
	if (Buffer.byteLength(JSON.stringify(formatted)) > MATRIX_EVENT_CONTENT_MAX_BYTES)
		return plainContent;
	return formatted;
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
