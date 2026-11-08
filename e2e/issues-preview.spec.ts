import { expect, test } from "@playwright/test";
import {
	ISSUES_CONTENT_PROTOCOL_VERSION,
	type IssueSummary,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";

for (const provider of ["github", "gitlab"] as const) {
	test(`${provider} previews bodies in place and drops stale replies`, async ({ page }) => {
		let projectId = "";
		let reads = 0;
		let delayed: (() => void) | undefined;
		let fail = false;
		const instanceUrl = provider === "github" ? "https://github.com" : "https://gitlab.com";
		const issues: IssueSummary[] = [1, 2].map((number) => ({
			reference: { provider, instanceUrl, projectId: "7", number },
			title: `Preview fixture ${number}`,
			url: `${instanceUrl}/team/repo/${provider === "gitlab" ? "-/" : ""}issues/${number}`,
			stage: number === 1 ? "backlog" : "closed",
			labels: [],
			updatedAt: "2026-01-01T00:00:00Z",
		}));
		await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
			const server = browser.connectToServer();
			browser.onMessage((message) => {
				const frame = JSON.parse(message.toString());
				const reply = (result: unknown) =>
					browser.send(JSON.stringify({ id: frame.id, ok: true, result }));
				if (frame.method === "issues.connection") {
					projectId = frame.params.projectId;
					reply({ projectId, instanceUrl, remoteProjectId: "7", connected: true });
				} else if (frame.method === "issues.list")
					reply({ issues, fetchedAt: "2026-01-01T00:00:00Z" });
				else if (frame.method === "issues.content") {
					reads++;
					expect(frame.params.projectId).toBe(projectId);
					const number = frame.params.reference.number;
					const send = () =>
						fail
							? browser.send(JSON.stringify({ id: frame.id, ok: false, error: "fixture failure" }))
							: reply({
									description:
										number === 1
											? "**Body one**\n\n[Safe link](https://example.com)\n\n<script>evil()</script>"
											: "",
									url: issues[number - 1]?.url,
								});
					if (reads === 1) delayed = send;
					else send();
				} else server.send(message);
			});
			server.onMessage((message) => browser.send(message));
		});
		await openFixtureProject(page);
		await enterDefaultWorkspace(page);
		const rail = page.getByTestId("tool-rail-issues");
		if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
		const toggles = page.getByTestId("issue-preview-toggle");
		await expect(toggles).toHaveCount(2);
		await expect(page.getByTestId("issue-body")).toHaveCount(0);
		expect(reads).toBe(0);
		await toggles.nth(0).click();
		await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByTestId("issue-body").getByRole("status")).toBeVisible();
		await toggles.nth(1).click();
		await expect(page.getByTestId("issue-body")).toContainText("no description");
		delayed?.();
		await expect(page.getByTestId("issue-body")).not.toContainText("Body one");
		await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "false");
		await toggles.nth(1).click();
		await expect(page.getByTestId("issue-body")).toHaveCount(0);
		fail = true;
		await toggles.nth(0).click();
		await expect(page.getByTestId("issue-body").getByRole("alert")).toBeVisible();
		fail = false;
		await page.getByTestId("issue-body").getByRole("button", { name: "Retry" }).click();
		await expect(page.getByTestId("issue-body").locator("strong")).toHaveText("Body one");
		await expect(page.getByTestId("issue-body").locator("script")).toHaveCount(0);
		await expect(page.getByTestId("issue-body").getByRole("link")).toHaveAttribute(
			"rel",
			"noopener noreferrer",
		);
		await page.getByRole("button", { name: "Refresh issues", exact: true }).click();
		await expect(page.getByTestId("issue-body")).toHaveCount(0);
	});
}

test("old hosts keep body preview disabled", async ({ page }) => {
	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		browser.onMessage((message) => {
			const frame = JSON.parse(message.toString());
			const reply = (result: unknown) =>
				browser.send(JSON.stringify({ id: frame.id, ok: true, result }));
			if (frame.method === "issues.connection")
				reply({
					projectId: frame.params.projectId,
					instanceUrl: "https://github.com",
					remoteProjectId: "7",
					connected: true,
				});
			else if (frame.method === "issues.list")
				reply({
					issues: [
						{
							reference: {
								provider: "github",
								instanceUrl: "https://github.com",
								projectId: "7",
								number: 1,
							},
							title: "Old fixture",
							url: "https://github.com/team/repo/issues/1",
							labels: [],
							stage: "closed",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
					fetchedAt: "2026-01-01T00:00:00Z",
				});
			else if (frame.method === "issues.content")
				throw new Error("Old host must not receive a body request");
			else server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(message.toString());
			if (frame.channel === WS_CHANNELS.serverWelcome)
				frame.data.protocolVersion = ISSUES_CONTENT_PROTOCOL_VERSION - 1;
			browser.send(JSON.stringify(frame));
		});
	});
	await openFixtureProject(page);
	await enterDefaultWorkspace(page);
	const rail = page.getByTestId("tool-rail-issues");
	if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
	await expect(page.getByTestId("issue-preview-toggle")).toBeDisabled();
	await expect(page.getByRole("link", { name: "#1 Old fixture" })).toHaveAttribute(
		"href",
		"https://github.com/team/repo/issues/1",
	);
});
