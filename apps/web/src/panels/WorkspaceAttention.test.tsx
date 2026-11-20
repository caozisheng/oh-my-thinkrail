import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceAttention } from "./WorkspaceAttention";

test("workspace attention is a static warning question with one generic accessible meaning", () => {
	const markup = renderToStaticMarkup(<WorkspaceAttention />);
	expect(markup).toContain('aria-label="Needs attention"');
	expect(markup).toContain('title="Needs attention"');
	expect(markup).toContain('data-testid="workspace-attention"');
	expect(markup).toContain("text-feedback-warning");
	expect(markup).toContain("<svg");
	expect(markup).toContain('aria-hidden="true"');
	expect(markup).not.toContain("animate-");
	expect(markup).not.toContain("<button");
	expect(markup).not.toContain("tabindex");
});
