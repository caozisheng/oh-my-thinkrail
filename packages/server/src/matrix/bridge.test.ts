import { expect, test } from "bun:test";
import {
	matrixFormattedContent,
	parseMatrixCommand,
	renderMatrixMarkdown,
	transcriptProjection,
} from "./bridge";

test("explicit commands never silently become prompts", () => {
	expect(parseMatrixCommand("hello")).toEqual({ kind: "prompt", text: "hello" });
	expect(parseMatrixCommand("!omt followup later")).toEqual({ kind: "followup", text: "later" });
	expect(parseMatrixCommand("!omt say !omt stop")).toEqual({ kind: "prompt", text: "!omt stop" });
	expect(parseMatrixCommand("!omt typo")).toEqual({ kind: "invalid" });
	expect(parseMatrixCommand("!omt stop")).toEqual({ kind: "stop" });
	expect(parseMatrixCommand("!omt answer interaction-7 2;text:custom")).toEqual({
		kind: "answer",
		interactionId: "interaction-7",
		text: "2;text:custom",
	});
});

test("Matrix Markdown renders a plain-text fallback and sanitized HTML", async () => {
	const rendered = await renderMatrixMarkdown(`# Title

**bold** and \`code\`

- first
- second`);
	expect(rendered.body).toContain("# Title");
	expect(rendered.body).toContain("**bold**");
	expect(rendered.formattedBody).toContain("<h1>Title</h1>");
	expect(rendered.formattedBody).toContain("<strong>bold</strong>");
	expect(rendered.formattedBody).toContain("<code>code</code>");
	expect(rendered.formattedBody).toContain("<ul>");
});

test("Matrix Markdown escapes raw HTML and removes unsafe tags, attributes and URI schemes", async () => {
	const rendered = await renderMatrixMarkdown(
		`<script>alert("x")</script><b onclick="x()">safe?</b>

[bad](javascript:alert(1)) [good](https://example.org)`,
	);
	expect(rendered.formattedBody).not.toContain("<script");
	expect(rendered.formattedBody).not.toContain("<b onclick=");
	expect(rendered.formattedBody).not.toContain("javascript:");
	expect(rendered.formattedBody).toContain("https://example.org");
	expect(rendered.body).toContain('<script>alert("x")</script>');
});

test("Matrix Markdown formatting tolerates unfinished streaming fences", async () => {
	const rendered = await renderMatrixMarkdown(`\`\`\`ts
const answer = 42`);
	expect(rendered.formattedBody).toContain("<pre><code");
	expect(rendered.formattedBody).toContain("const answer = 42");
});

test("Matrix rich text includes markdown formatting with the original plain-text fallback", async () => {
	const markdown = `# Answer

**important**

- one
- two`;
	const rendered = await matrixFormattedContent("Assistant: ", markdown);
	expect(rendered.body).toBe(`Assistant: ${markdown}`);
	expect(rendered.format).toBe("org.matrix.custom.html");
	expect(rendered.formatted_body).toContain("<h1>Answer</h1>");
	expect(rendered.formatted_body).toContain("<strong>important</strong>");
	expect(rendered.formatted_body).toContain("<ul>");
});

test("Matrix rich text treats raw HTML as text and sanitizes dangerous links", async () => {
	const rendered = await matrixFormattedContent(
		"",
		'<script>run()</script> <img src=x onerror="run()"> [unsafe](<javascript:run>) [safe](https://example.org)',
	);
	expect(rendered.formatted_body).not.toContain("<script");
	expect(rendered.formatted_body).not.toContain("<img");
	expect(rendered.formatted_body).not.toContain('href="javascript:');
	expect(rendered.formatted_body).toContain("https://example.org");
	expect(rendered.body).toContain("<script>");
});

test("Matrix rich text allows only safe structural tags and attributes", async () => {
	const rendered = await matrixFormattedContent(
		"",
		"<details open><summary>x</summary></details>\n\n```ts\nconst x = 1;\n```",
	);
	expect(rendered.formatted_body).not.toContain("<details");
	expect(rendered.formatted_body).not.toContain("<details");
	expect(rendered.formatted_body).toContain('<pre><code class="language-ts">');
});

test("transcript projections exclude empty assistant text blocks", () => {
	expect(
		transcriptProjection({
			role: "assistant",
			content: [
				{ type: "text", text: "  \n  " },
				{ type: "toolCall", name: "shell" },
			],
		}),
	).toBeNull();
	expect(
		transcriptProjection({ role: "assistant", content: [{ type: "toolCall", name: "shell" }] }),
	).toBeNull();
	expect(
		transcriptProjection({ role: "assistant", content: [{ type: "text", text: "Answer" }] }),
	).toBe("Assistant: Answer");
});

test("transcript projections exclude thinking, tool data and control messages", () => {
	expect(
		transcriptProjection({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "secret" },
				{ type: "text", text: "visible" },
				{ type: "toolCall", name: "bash", arguments: { command: "secret" } },
			],
		}),
	).toBe("Assistant: visible");
	expect(
		transcriptProjection({ role: "toolResult", content: [{ type: "text", text: "secret" }] }),
	).toBe(null);
	expect(
		transcriptProjection({
			role: "assistant",
			content: [{ type: "text", text: "[thinkrail:todo-nudge] internal" }],
		}),
	).toBe(null);
	expect(transcriptProjection({ role: "user", content: "hello" })).toBe("User: hello");
});
