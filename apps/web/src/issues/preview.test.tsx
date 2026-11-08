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
