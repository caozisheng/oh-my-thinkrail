import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
	ISSUES_GROUPS_PROTOCOL_VERSION,
	type IssueConnectionInput,
	type IssueSessionLaunch,
	type IssueSummary,
	type Project,
	type ServerWelcome,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { enterDefaultWorkspace, openFixtureProject, pressPlatformShortcut } from "./fixtures/app";
import { gitAs } from "./fixtures/git";
import { E2E_DATA_DIR, E2E_PLAIN_DIR } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

async function openFixtureGroup(page: Page) {
	await openFixtureProject(page);
	mkdirSync(E2E_PLAIN_DIR, { recursive: true });
	const root = mkdtempSync(join(E2E_PLAIN_DIR, "group-"));
	for (const path of ["app", "library"]) {
		const repo = join(root, path);
		mkdirSync(repo);
		gitAs(repo, "init", "-q", "-b", "main");
		gitAs(repo, "commit", "--allow-empty", "-qm", "fixture");
	}
	writeFileSync(
		join(root, "SPEC.md"),
		"---\nid: fixture-group-spec\ntype: module-design\ntitle: Group fixture spec\n---\nGroup contract.\n",
	);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	const imported = await wire.request("project.importGroup", {
		root,
		paths: ["app", "library"],
		name: "Fixture group",
	});
	wire.close();
	const groupId = imported.projects[0]?.projectGroup?.id;
	if (!groupId) throw new Error("Fixture group import failed");
	await page
		.locator(`[data-testid="project-group"][data-group="${groupId}"]`)
		.getByTestId("project-group-overview")
		.click();
	await expect(page.getByTestId("project-group-home-title")).toHaveText("Fixture group");
	return { groupId, root };
}

test("a group owns its tracker, previews and combined people filters", async ({ page }) => {
	const instanceUrl = "http://forge.example:8929/scm";
	const token = "disposable-group-browser-pat";
	let connected = false;
	let projectId = "";
	let submitted: IssueConnectionInput | undefined;
	let listReads = 0;
	let launch: IssueSessionLaunch | undefined;
	let designTarget: unknown;
	const selections = new Map<string, string[]>();

	const issues: IssueSummary[] = [7, 9].map((id) => ({
		reference: { provider: "gitlab", instanceUrl, projectId: String(id), number: 12 },
		projectPath: `company/platform/project-${id}`,
		title: `Group fixture ${id}`,
		assignees: [{ id, name: id === 7 ? "张三" : "李四", username: id === 7 ? "alice" : "bob" }],
		author: { id: 90, name: "王五", username: "owner" },
		url: `${instanceUrl}/company/platform/project-${id}/-/issues/12`,
		stage: "backlog",
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
				reply(
					connected
						? { projectId, instanceUrl, remoteProjectId: "7", scope: "group", connected }
						: null,
				);
			} else if (frame.method === "issues.connect") {
				submitted = frame.params.input;
				connected = true;
				reply({ projectId, instanceUrl, remoteProjectId: "7", scope: "group", connected });
			} else if (frame.method === "issues.list") {
				listReads++;
				reply({ issues, fetchedAt: "2026-01-01T00:00:00Z" });
			} else if (frame.method === "issues.repositories")
				reply({
					projectIds: selections.get(JSON.stringify(frame.params.reference)) ?? [],
					locked: false,
				});
			else if (frame.method === "issues.setRepositories") {
				selections.set(JSON.stringify(frame.params.reference), frame.params.projectIds);
				reply({ projectIds: frame.params.projectIds, locked: false });
			} else if (frame.method === "issues.detail") {
				const ref = frame.params.reference;
				const issue = issues.find((row) => row.reference.projectId === ref.projectId);
				reply({
					reference: ref,
					title: issue?.title,
					url: issue?.url,
					description: `Body for project ${ref.projectId}`,
					comments: [
						{
							id: 1,
							body: `Comment for project ${ref.projectId}`,
							createdAt: "2026-01-01T00:00:00Z",
							author: null,
						},
					],
					fetchedAt: "2026-01-01T00:00:00Z",
				});
			} else if (frame.method === "issues.implementationHistory") {
				reply({ entries: [] });
			} else if (frame.method === "issues.beginDesign") {
				designTarget = frame.params;
				reply(launch);
			} else if (frame.method === "issues.disconnect") {
				connected = false;
				reply({ ok: true });
			} else server.send(message);
		});
		server.onMessage((message) => browser.send(message));
	});
	const { groupId } = await openFixtureGroup(page);
	const projectsFile = join(E2E_DATA_DIR, "projects.json");
	const projects: Project[] = JSON.parse(readFileSync(projectsFile, "utf8"));
	const members = projects.filter((project) => project.projectGroup?.id === groupId);
	writeFileSync(
		projectsFile,
		JSON.stringify(
			projects.map((project) => {
				if (project.projectGroup?.id !== groupId) return project;
				const { trusted: _trusted, ...rest } = project;
				return { ...rest, piResourceTrust: "granted" };
			}),
		),
	);
	await page.reload();
	await page
		.locator(`[data-testid="project-group"][data-group="${groupId}"]`)
		.getByTestId("project-group-overview")
		.click();
	await expect(page.getByTestId("project-group-home-title")).toHaveText("Fixture group");

	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const { workspace } = await wire.request("project.openGroup", { groupId });
		const session = await wire.request("session.create", { workspaceId: workspace.id });
		launch = { workspaceId: workspace.id, sessionId: session.sessionId };
	} finally {
		wire.close();
	}
	await page.getByTestId("group-home-open-issues").click();
	const rail = page.getByTestId("tool-rail-issues");
	if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
	await page.getByTestId("issues-address").fill(`${instanceUrl}/groups/company/platform/-/issues`);
	await page.getByTestId("issues-instance").fill(instanceUrl);
	await expect(page.getByTestId("issues-project")).toHaveValue("company/platform");
	await page.getByTestId("issues-token").fill(token);
	await expect(page.getByTestId("issues-connect")).toBeDisabled();
	await page.getByTestId("issues-http-consent").check();
	await page.getByTestId("issues-connect").click();
	await expect(page.getByTestId("issues-state")).toBeVisible();
	expect(submitted).toEqual({
		instanceUrl,
		projectId: "company/platform",
		scope: "group",
		token,
		httpConsent: { instanceUrl },
	});
	for (const id of [7, 9]) {
		const card = page
			.getByTestId("issue-card")
			.filter({ hasText: `company/platform/project-${id}#12` });
		await expect(card).toBeVisible();
		await expect(card.getByRole("link")).toHaveAttribute(
			"href",
			`${instanceUrl}/company/platform/project-${id}/-/issues/12`,
		);
		await card.getByTestId("issue-preview-toggle").click();
		await expect(card.getByTestId("issue-body")).toContainText(`Body for project ${id}`);
		await expect(card.getByTestId("issue-body")).toContainText(`Comment for project ${id}`);
		await expect(card.getByTestId("issue-action-design")).toBeEnabled();
		await expect(card.getByTestId("issue-action-implement")).toBeEnabled();
		await expect(card.getByTestId("issue-repositories")).toBeEnabled();
		const history = card.getByTestId("issue-history");
		await expect(history).toHaveAccessibleName("View implementation history");
		await expect(history).toHaveText("");
		const geometry = await card.evaluate((element) => ({
			card: element.getBoundingClientRect().width,
			title: element.querySelector("a")?.parentElement?.getBoundingClientRect().width ?? 0,
			overflow: element.scrollWidth - element.clientWidth,
		}));
		expect(geometry.title).toBeGreaterThan(geometry.card * 0.45);
		expect(geometry.overflow).toBeLessThanOrEqual(1);
		await history.click();
		await expect(page.getByRole("dialog")).toContainText(
			"No archived implementation conversations.",
		);
		await page.keyboard.press("Escape");
	}
	const linkedCard = page.getByTestId("issue-card").first();
	await linkedCard.getByTestId("issue-repositories").click();
	await expect(page.getByTestId("issue-repository-option")).toHaveCount(members.length);
	const option = page.getByTestId("issue-repository-option").first();
	await option.click();
	await expect(option).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Escape");
	const persisted: Project[] = JSON.parse(readFileSync(projectsFile, "utf8"));
	for (const member of persisted.filter((project) => project.projectGroup?.id === groupId)) {
		expect(member.trusted).toBeUndefined();
		expect(member.piResourceTrust).toBe("granted");
	}
	const beforeRemount = listReads;
	await rail.click();
	await expect(page.getByTestId("issues-state")).toHaveCount(0);
	await rail.click();
	await expect(page.getByTestId("issue-card")).toHaveCount(2);
	expect(listReads).toBe(beforeRemount);
	await page.getByRole("button", { name: "Refresh issues", exact: true }).click();
	await expect.poll(() => listReads).toBe(beforeRemount + 1);
	await page.getByTestId("issues-filter-assignee").fill("@ALICE");
	await expect(page.getByTestId("issue-card")).toHaveCount(1);
	await expect(page.getByTestId("issue-card")).toContainText("Group fixture 7");
	await page.getByTestId("issues-filter-author").fill("王五");
	await expect(page.getByTestId("issue-card")).toHaveCount(1);
	await page.getByTestId("issues-filter-author").fill("nobody");
	await expect(page.getByTestId("issue-card")).toHaveCount(0);
	await page.getByTestId("issues-filter-author").fill("owner");
	await page.getByTestId("issues-filter-assignee").fill("李四");
	await expect(page.getByTestId("issue-card")).toContainText("Group fixture 9");
	await page.getByTestId("issues-filter-assignee").fill("");
	await page.getByTestId("issues-filter-author").fill("");
	await page
		.getByTestId("issue-card")
		.filter({ hasText: "Group fixture 9" })
		.getByTestId("issue-action-design")
		.click();
	await expect(page.getByTestId("chat-input")).toHaveValue("");
	await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "group");
	expect(designTarget).toEqual({
		projectId: groupId,
		reference: issues[1]?.reference,
		locale: "en",
	});
	await expect(page).toHaveURL(new RegExp(launch?.sessionId ?? "missing-session"));
	await page.reload();
	await expect(
		page.getByRole("link", { name: "company/platform/project-9#12 Group fixture 9" }),
	).toBeVisible();
	await page.getByTestId("issues-disconnect").click();
	await expect(page.getByTestId("issues-address")).toBeVisible();
	await expect(page.getByTestId("issues-token")).toHaveValue("");
});

test("an older host blocks group credentials while project association remains available", async ({
	page,
}) => {
	let submitted = false;
	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		browser.onMessage((message) => {
			const frame = JSON.parse(message.toString());
			if (frame.method === "issues.connect") {
				submitted = true;
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(message.toString()) as { channel?: string; data?: ServerWelcome };
			if (frame.channel === WS_CHANNELS.serverWelcome && frame.data)
				frame.data.protocolVersion = ISSUES_GROUPS_PROTOCOL_VERSION - 1;
			browser.send(JSON.stringify(frame));
		});
	});
	await openFixtureProject(page);
	await enterDefaultWorkspace(page);
	const rail = page.getByTestId("tool-rail-issues");
	if ((await rail.getAttribute("aria-pressed")) !== "true") await rail.click();
	await page
		.getByTestId("issues-address")
		.fill("https://gitlab.com/groups/company/platform/-/issues");
	await page.getByTestId("issues-token").fill("disposable-group-browser-pat");
	await expect(page.getByTestId("issues-provider-notice")).toContainText("v136");
	await expect(page.getByTestId("issues-connect")).toBeDisabled();
	expect(submitted).toBe(false);
	await page.getByTestId("issues-address").fill("https://gitlab.com/company/platform.git");
	await expect(page.getByTestId("issues-connect")).toBeEnabled();
});

test("Group Home opens its own conversations, specs and terminal and survives reload", async ({
	page,
}) => {
	const { groupId, root } = await openFixtureGroup(page);
	await page.getByTestId("group-home-open-specs").click();
	await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "group");
	await expect(page.getByTestId("tool-rail-specs")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByText("Group fixture spec", { exact: true })).toBeVisible();
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	const { project, workspace } = await wire.request("project.openGroup", { groupId });
	expect(project.kind).toBe("group");
	expect(workspace).toMatchObject({
		kind: "group",
		projectId: groupId,
		worktreePath: root,
		branch: "",
	});
	expect(await wire.request("workspace.list", { projectId: groupId })).toHaveLength(1);
	await expect(wire.request("git.status", { workspaceId: workspace.id })).rejects.toThrow();
	wire.close();
	await page.getByTestId("scope-project").click();
	await page.getByTestId("scope-project-home").click();
	await page.getByTestId("group-home-open-chat").click();
	await expect(page.getByTestId("chat-input")).toBeVisible();
	await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "group");
	await page.reload();
	await expect(page.getByTestId("chat-input")).toBeVisible();
	await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "group");
	await page.getByTestId("scope-project").click();
	await page.getByTestId("scope-project-home").click();
	await page.getByTestId("group-home-open-terminal").click();
	await expect(page.locator(".xterm-screen").first()).toBeVisible();
});

test("group Default is a first-class workbench and every group chat belongs to it with an empty draft", async ({
	page,
}) => {
	const { groupId } = await openFixtureGroup(page);
	const groupRow = page.locator(`[data-testid="project-group"][data-group="${groupId}"]`);
	await groupRow.getByTestId("project-group-open").click();
	await expect(page.getByTestId("workspace-shell-layout")).toBeVisible();
	await expect(page.getByTestId("project-group-home")).toHaveCount(0);
	await expect(groupRow.getByTestId("group-default-workspace")).toHaveAttribute(
		"data-active",
		"true",
	);
	await page.getByTestId("start-chat").click();
	await expect(page.getByTestId("chat-input")).toHaveValue("");
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const { workspace } = await wire.request("project.openGroup", { groupId });
		await expect
			.poll(async () => (await wire.request("session.list", { workspaceId: workspace.id })).length)
			.toBe(1);
		await page.reload();
		await expect(page.getByTestId("chat-input")).toHaveValue("");
		await expect(groupRow.getByTestId("group-default-workspace")).toHaveAttribute(
			"data-active",
			"true",
		);
		await groupRow.getByTestId("project-group-start").click();
		await expect
			.poll(async () => (await wire.request("session.list", { workspaceId: workspace.id })).length)
			.toBe(2);
		await expect(page.getByTestId("chat-input")).toHaveValue("");
		await groupRow.getByTestId("project-group-overview").click();
		await pressPlatformShortcut(page, "N");
		await expect
			.poll(async () => (await wire.request("session.list", { workspaceId: workspace.id })).length)
			.toBe(3);
		await expect(page.getByTestId("chat-input")).toHaveValue("");
		await expect(page.getByTestId("scope-context")).toHaveAttribute("data-context", "group");
		const members = (await wire.request("project.list", {})).filter(
			(project) => project.projectGroup?.id === groupId,
		);
		for (const member of members) {
			const workspaces = await wire.request("workspace.list", { projectId: member.id });
			for (const row of workspaces)
				expect(await wire.request("session.list", { workspaceId: row.id })).toHaveLength(0);
		}
	} finally {
		wire.close();
	}
});
