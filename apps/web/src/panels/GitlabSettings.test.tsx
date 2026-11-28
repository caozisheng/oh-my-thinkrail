import { expect, test } from "bun:test";
import { EN } from "@thinkrail/locales";
import { renderToStaticMarkup } from "react-dom/server";
import { GitlabStatusView, gitlabProbe } from "./GitlabSettings";

const view = (props: Partial<Parameters<typeof GitlabStatusView>[0]>) =>
	renderToStaticMarkup(
		<GitlabStatusView
			status={null}
			checking={false}
			failed={false}
			onRefresh={() => {}}
			{...props}
		/>,
	);

test("unanswered GitLab probe renders checking, not disconnected", () => {
	const markup = view({ checking: true });
	expect(markup).toContain(`aria-label="${EN["settings.gitlab.checking"]}"`);
	expect(markup).not.toContain("data-connected");
});

test("GitLab state reflects authentication without exposing account or credentials", () => {
	const connected = view({ status: { connected: true } });
	expect(connected).toContain('data-connected="true"');
	expect(connected).toContain(String(EN["settings.gitlab.connected"]));
	expect(connected).not.toContain("token");
	expect(connected).not.toContain("octocat");

	const disconnected = view({ status: { connected: false } });
	expect(disconnected).toContain('data-connected="false"');
	expect(disconnected).toContain('<code class="tr-code-text">glab auth login</code>');
});

test("failed GitLab probe preserves the refresh control", () => {
	const markup = view({ failed: true });
	expect(markup).toContain(String(EN["settings.gitlab.checkFailed"]).replaceAll("'", "&#x27;"));
	expect(markup).toContain('data-testid="settings-gitlab-refresh"');
});

test("a rejection keeps the last auth state and only the latest probe settles", () => {
	let probe = gitlabProbe(
		{ status: { connected: true }, failed: false, pending: null },
		{ type: "start", id: 1 },
	);
	probe = gitlabProbe(probe, { type: "reject", id: 1 });
	expect(probe).toEqual({ status: { connected: true }, failed: true, pending: null });
	probe = gitlabProbe(probe, { type: "start", id: 2 });
	probe = gitlabProbe(probe, { type: "answer", id: 1, status: { connected: false } });
	expect(probe.pending).toBe(2);
	probe = gitlabProbe(probe, { type: "answer", id: 2, status: { connected: false } });
	expect(probe).toEqual({ status: { connected: false }, failed: false, pending: null });
});
