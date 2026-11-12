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
				else if (frame.method === "issues.detail") {
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
									comments: [
										{
											id: 1,
											body: "Full comment",
											author: { name: "Alice", username: "alice" },
											createdAt: "2026-01-01T00:00:00Z",
										},
									],
								});
					if (reads === 1) delayed = send;
					else send();
				} else server.send(message);
			});
			server.onMessage((message) => browser.send(message));
		});
		await openFixtureProject(page, { issueAlreadyAssociated: true });
		await enterDefaultWorkspace(page);
		const rail = page.getByTestId("tool-rail-issues");
		if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
		await page.getByTestId("issues-trust").click();
		const toggles = page.getByTestId("issue-preview-toggle");
		await expect(toggles).toHaveCount(2);
		for (const [index, stage] of ["Backlog", "Closed"].entries()) {
			const group = page.getByRole("region", { name: stage, exact: true });
			await expect(group.getByRole("heading")).toHaveText(`${stage} · 1`);
			const card = group.getByRole("article");
			await expect(card.getByRole("link")).toHaveText(`#${index + 1} Preview fixture ${index + 1}`);
			await expect(card.locator(":scope > p")).toHaveCount(0);
		}
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
		await expect(page.getByTestId("issue-body")).toContainText("Full comment");
		await expect(page.getByTestId("issue-body")).toContainText("Alice");
		const commentTime = page.getByTestId("issue-body").locator("time");
		await expect(commentTime).toHaveAttribute("datetime", "2026-01-01T00:00:00Z");
		await expect(commentTime).toBeVisible();
		await expect(commentTime).not.toHaveText("");
		await expect(page.getByRole("link", { name: "#1 Preview fixture 1" })).toHaveAttribute(
			"target",
			"_blank",
		);
		await expect(page.getByTestId("issue-body").getByRole("link")).toHaveAttribute(
			"rel",
			"noopener noreferrer",
		);
		await page.getByRole("button", { name: "Refresh issues", exact: true }).click();
		await expect(page.getByTestId("issue-body")).toHaveCount(0);
	});
}

for (const provider of ["github", "gitlab"] as const) {
	test(`${provider} v113 keeps the eye-button body preview without requesting detail`, async ({
		page,
	}) => {
		let contentReads = 0;
		let detailReads = 0;
		const instanceUrl = provider === "github" ? "https://github.com" : "https://gitlab.com";
		const issue: IssueSummary = {
			reference: { provider, instanceUrl, projectId: "7", number: 1 },
			title: "v113 fixture",
			url: `${instanceUrl}/team/repo/${provider === "gitlab" ? "-/" : ""}issues/1`,
			stage: "closed",
			labels: [],
			updatedAt: "2026-01-01T00:00:00Z",
		};
		await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
			const server = browser.connectToServer();
			browser.onMessage((message) => {
				const frame = JSON.parse(message.toString());
				const reply = (result: unknown) =>
					browser.send(JSON.stringify({ id: frame.id, ok: true, result }));
				if (frame.method === "issues.connection")
					reply({
						projectId: frame.params.projectId,
						instanceUrl,
						remoteProjectId: "7",
						connected: true,
					});
				else if (frame.method === "issues.list")
					reply({ issues: [issue], fetchedAt: "2026-01-01T00:00:00Z" });
				else if (frame.method === "issues.content") {
					contentReads++;
					expect(frame.params.reference).toEqual(issue.reference);
					reply({ description: "**Legacy body**", url: issue.url });
				} else if (frame.method === "issues.detail") {
					detailReads++;
					throw new Error("v113 host must not receive a detail request");
				} else server.send(message);
			});
			server.onMessage((message) => {
				const frame = JSON.parse(message.toString());
				if (frame.channel === WS_CHANNELS.serverWelcome)
					frame.data.protocolVersion = ISSUES_CONTENT_PROTOCOL_VERSION;
				browser.send(JSON.stringify(frame));
			});
		});
		await openFixtureProject(page, { issueAlreadyAssociated: true });
		await enterDefaultWorkspace(page);
		const rail = page.getByTestId("tool-rail-issues");
		if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
		await page.getByTestId("issues-trust").click();
		const toggle = page.getByTestId("issue-preview-toggle");
		await expect(toggle).toBeEnabled();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(contentReads).toBe(0);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByTestId("issue-body").locator("strong")).toHaveText("Legacy body");
		await expect(page.getByTestId("issue-body").locator("time")).toHaveCount(0);
		await expect(page.getByRole("link", { name: "#1 v113 fixture" })).toHaveAttribute(
			"href",
			issue.url,
		);
		expect(contentReads).toBe(1);
		await toggle.click();
		await expect(page.getByTestId("issue-body")).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(detailReads).toBe(0);
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
			else if (frame.method === "issues.content" || frame.method === "issues.detail")
				throw new Error("Old host must not receive a body or detail request");
			else server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(message.toString());
			if (frame.channel === WS_CHANNELS.serverWelcome)
				frame.data.protocolVersion = ISSUES_CONTENT_PROTOCOL_VERSION - 1;
			browser.send(JSON.stringify(frame));
		});
	});
	await openFixtureProject(page, { issueAlreadyAssociated: true });
	await enterDefaultWorkspace(page);
	const rail = page.getByTestId("tool-rail-issues");
	if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
	await page.getByTestId("issues-trust").click();
	await expect(page.getByTestId("issue-preview-toggle")).toBeDisabled();
	await expect(page.getByRole("link", { name: "#1 Old fixture" })).toHaveAttribute(
		"href",
		"https://github.com/team/repo/issues/1",
	);
});
