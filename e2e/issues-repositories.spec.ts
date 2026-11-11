import { expect, test } from "@playwright/test";
import type { IssueSummary } from "@thinkrail/contracts";
import { enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";

test("linked repositories hydrate before opening the control and rehydrate on refresh", async ({
	page,
}) => {
	let reads = 0;
	let linked = true;
	let release: (() => void) | undefined;
	const issue: IssueSummary = {
		reference: { provider: "github", instanceUrl: "https://github.com", projectId: "7", number: 1 },
		title: "Repository fixture",
		url: "https://github.com/team/repo/issues/1",
		stage: "backlog",
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
					instanceUrl: "https://github.com",
					remoteProjectId: "7",
					connected: true,
				});
			else if (frame.method === "issues.list")
				reply({ issues: [issue], fetchedAt: "2026-01-01T00:00:00Z" });
			else if (frame.method === "issues.repositories") {
				reads++;
				const selection = { projectIds: linked ? ["api-local"] : [], locked: false };
				if (reads === 2) release = () => reply(selection);
				else reply(selection);
			} else server.send(message);
		});
		server.onMessage((message) => browser.send(message));
	});
	await openFixtureProject(page, { issueAlreadyAssociated: true });
	await enterDefaultWorkspace(page);
	const rail = page.getByTestId("tool-rail-issues");
	if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
	const control = page.getByTestId("issue-repositories");
	await expect(control).toHaveAttribute("data-variant", "soft-primary");
	expect(reads).toBe(1);
	await page.getByRole("button", { name: "Refresh issues", exact: true }).click();
	await expect.poll(() => reads).toBe(2);
	await expect(control).toHaveAttribute("data-variant", "soft-primary");
	linked = false;
	await page.getByRole("button", { name: "Refresh issues", exact: true }).click();
	await expect.poll(() => reads).toBe(3);
	await expect(control).toHaveAttribute("data-variant", "ghost");
	await control.click();
	await expect.poll(() => reads).toBe(4);
	release?.();
	await expect(page.getByRole("listbox")).toBeVisible();
	await expect(control).toHaveAttribute("data-variant", "ghost");
});
