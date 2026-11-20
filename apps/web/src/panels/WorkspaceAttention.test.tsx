import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceAttention } from "./WorkspaceAttention";

test("workspace attention is a static warning question for pending input", () => {
	const markup = renderToStaticMarkup(<WorkspaceAttention />);
	expect(markup).toContain('aria-label="Your input is needed"');
	expect(markup).toContain('title="Your input is needed"');
	expect(markup).toContain('data-testid="workspace-attention"');
	expect(markup).toContain("text-feedback-warning");
	expect(markup).toContain("<svg");
	expect(markup).toContain('aria-hidden="true"');
	expect(markup).not.toContain("animate-");
	expect(markup).not.toContain("<button");
	expect(markup).not.toContain("tabindex");
});
