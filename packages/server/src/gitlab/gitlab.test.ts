import { afterEach, expect, test } from "bun:test";
import { gitlabAuthStatus, gitlabRefresh, parseGlabAuthStatus } from "./gitlab";

const saved = process.env.THINKRAIL_GITLAB_OFFLINE;
afterEach(() => {
	if (saved === undefined) delete process.env.THINKRAIL_GITLAB_OFFLINE;
	else process.env.THINKRAIL_GITLAB_OFFLINE = saved;
});

test("parseGlabAuthStatus reflects whether a GitLab host is authenticated", () => {
	expect(
		parseGlabAuthStatus(
			"gitlab.com\n  ✓ Logged in to gitlab.com as octocat (oauth_token)\n  ✓ Token: glpat-secret",
		),
	).toEqual({ connected: true });
	expect(parseGlabAuthStatus("You are not logged into any GitLab hosts")).toEqual({
		connected: false,
	});
});

test("offline status and refresh report disconnected without invoking glab", async () => {
	process.env.THINKRAIL_GITLAB_OFFLINE = "1";
	expect(await gitlabAuthStatus()).toEqual({ connected: false });
	expect(await gitlabRefresh()).toEqual({ connected: false });
});
