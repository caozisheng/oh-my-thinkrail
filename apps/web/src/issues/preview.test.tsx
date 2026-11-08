import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueBody, issueResourceUrl } from "./IssueBody";

const base = "https://github.com/team/repo/issues/42";
test("preview resources resolve relative paths and reject unsafe schemes and credentials", () => {
	for (const value of [
		"javascript:alert(1)",
		"data:image/svg+xml,evil",
		"file:///secret",
		"https://user:pass@example.com/x",
	])
		expect(issueResourceUrl(value, base)).toBe("");
	expect(issueResourceUrl("../image.png", base)).toBe("https://github.com/team/repo/image.png");
	expect(issueResourceUrl("https://images.example/x.png", base)).toBe(
		"https://images.example/x.png",
	);
});
test("body renders GFM, safe links and images but never executes raw HTML", () => {
	const html = renderToStaticMarkup(
		<IssueBody
			id="body"
			onRetry={() => {}}
			preview={{
				key: "42",
				identity: "fixture",
				status: "ready",
				content: {
					url: base,
					description:
						"**Bold**\n\n~~removed~~\n\n[link](../docs)\n\n![alt](../image.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:evil)\n\n![blocked](data:image/png,evil)",
				},
			}}
		/>,
	);
	expect(html).toContain("<strong>Bold</strong>");
	expect(html).toContain("<del>removed</del>");
	expect(html).toContain('target="_blank" rel="noopener noreferrer"');
	expect(html).toContain('src="https://github.com/team/repo/image.png"');
	expect(html).toContain('alt="alt"');
	expect(html).not.toContain("<script");
	expect(html).not.toContain("javascript:");
	expect(html).not.toContain("data:image");
	expect(html).toContain("blocked");
});
test("GitHub HTML attachment images render without passing through HTML attributes", () => {
	const url = "https://github.com/user-attachments/assets/e083d39a-b461-4006-a278-6f9084443caa";
	const html = renderToStaticMarkup(
		<IssueBody
			id="body"
			onRetry={() => {}}
			preview={{
				key: "5",
				identity: "fixture",
				status: "ready",
				content: {
					url: base,
					description: `icon refer to\n\n<img width="623" height="366" alt="Image &amp; details" src="${url}" onerror="evil()" style="display:none" />\n\n<img src="javascript:evil()" alt="unsafe" /><script><img src="https://evil.example/tracker" /></script>`,
				},
			}}
		/>,
	);
	expect(html).toContain(`src="${url}"`);
	expect(html).toContain('alt="Image &amp; details"');
	for (const forbidden of [
		"onerror",
		"display:none",
		'width="623"',
		"javascript:",
		"evil.example",
		"<script",
	])
		expect(html).not.toContain(forbidden);
});

test("HTML extraction preserves inert parser contexts and quoted attributes", () => {
	for (const description of [
		'before <script>"</style>"<img src="https://evil.example/tracker"></script>',
		'<template><template></template><img src="https://evil.example/tracker"></template>',
		'<script>"</style>"<img src="https://evil.example/tracker"></script>',
	]) {
		const html = renderToStaticMarkup(
			<IssueBody
				id="body"
				onRetry={() => {}}
				preview={{
					key: "5",
					identity: "fixture",
					status: "ready",
					content: { url: base, description },
				}}
			/>,
		);
		expect(html).not.toContain("<img");
	}
	const html = renderToStaticMarkup(
		<IssueBody
			id="body"
			onRetry={() => {}}
			preview={{
				key: "5",
				identity: "fixture",
				status: "ready",
				content: {
					url: base,
					description: '<img alt="<script>" src="https://good.example/image">',
				},
			}}
		/>,
	);
	expect(html).toContain('src="https://good.example/image"');
});

test("body states use local loading, empty and retry messages", () => {
	for (const status of ["loading", "error", "ready"] as const) {
		const html = renderToStaticMarkup(
			<IssueBody
				id="body"
				onRetry={() => {}}
				preview={{ key: "42", identity: "fixture", status }}
			/>,
		);
		expect(html).toContain(
			status === "loading"
				? 'role="status"'
				: status === "error"
					? 'role="alert"'
					: "no description",
		);
		if (status === "error") expect(html).toContain("Retry");
	}
});
