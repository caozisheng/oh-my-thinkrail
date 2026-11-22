import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { AskUserQuestionArgs } from "@thinkrail/pi-ask-user-question/core";
import {
	defaultWorkspaceRow,
	enterDefaultWorkspace,
	goProjectHome,
	openFixtureProject,
	openPersistedChat,
	openWorkspaceMenu,
	revealWorkbenchTool,
	setWindowFocus,
} from "./fixtures/app";
import { E2E_DATA_DIR, E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { E2eWire } from "./fixtures/wire";

const BASE_TS = 1_704_000_000_000;

async function reconnectWithSeed(page: Parameters<typeof openFixtureProject>[0]): Promise<void> {
	await page.reload();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(page.getByTestId("project-item").first()).toBeVisible();
}

async function expectAttentionDot(row: Locator): Promise<void> {
	await expect(row).toHaveAttribute("data-attention", "true");
	const isWorkspace = (await row.getAttribute("data-testid")) === "workspace-item";
	const indicator = row.getByTestId(isWorkspace ? "workspace-attention" : "attention-dot");
	await expect(indicator).toHaveAttribute(
		"aria-label",
		isWorkspace ? "Your input is needed" : "Needs attention",
	);
	if (isWorkspace) {
		await expect(indicator).toHaveClass(/text-feedback-warning/);
		await expect(row.getByTestId("attention-dot")).toHaveCount(0);
	} else {
		await expect(indicator.locator('[aria-hidden="true"]')).toHaveClass(/bg-primary/);
		await expect(row.getByTestId("workspace-attention")).toHaveCount(0);
	}
}

async function expectNoCompletionMarker(row: Locator): Promise<void> {
	await expect(row).not.toHaveAttribute("data-attention", /.+/);
	await expect(row.getByTestId("workspace-attention")).toHaveCount(0);
	await expect(row.getByTestId("attention-dot")).toHaveCount(0);
}

async function seedSentReviewComment(page: Page, sessionId: string): Promise<void> {
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const [project] = await wire.request("project.list", {});
		if (!project) throw new Error("No fixture project to attach the review comment to");
		const workspaces = await wire.request("workspace.list", { projectId: project.id });
		const workspace = workspaces.find((candidate) => candidate.kind === "default");
		if (!workspace) throw new Error("No default workspace for the review comment");
		const review = await wire.request("review.get", { workspaceId: workspace.id });
		const file = join(E2E_DATA_DIR, "reviews", `${workspace.id}.json`);
		const snapshot = JSON.parse(readFileSync(file, "utf8"));
		snapshot.comments.push({
			id: "rc_e2e_sent_attention",
			reviewId: review.review.id,
			kind: "review",
			anchor: null,
			body: "Open the finished review result.",
			status: "sent",
			sentAt: BASE_TS,
			sessionId,
			anchorState: "anchored",
			createdAt: BASE_TS,
		});
		snapshot.review.fileSessions = { ...snapshot.review.fileSessions, "": sessionId };
		writeFileSync(file, JSON.stringify(snapshot, null, 2));
	} finally {
		wire.close();
	}
}

test("a persisted question marks Projects only while its chat is foreground", async ({ page }) => {
	await openFixtureProject(page);
	const args = {
		questions: [
			{
				question: "Which rollout?",
				header: "Rollout",
				options: [
					{ label: "Canary", description: "Start small" },
					{ label: "All", description: "Ship everywhere" },
				],
			},
		],
	} satisfies AskUserQuestionArgs;
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "needs input state",
		messages: [
			{ role: "user", text: "Ask for rollout input.", timestamp: BASE_TS },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "state-question",
						name: "ask_user_question",
						arguments: args,
					},
				],
				stopReason: "toolUse",
				timestamp: BASE_TS + 1,
			},
		],
	});
	try {
		await reconnectWithSeed(page);
		const project = page.getByTestId("project-item").first();
		const expand = project.getByTestId("project-expand");
		const workspace = defaultWorkspaceRow(page);
		await expectNoCompletionMarker(workspace);
		await expect(expand).toHaveAttribute("data-expanded", "true");
		await expand.click();
		await expectNoCompletionMarker(project);
		await expand.click();
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "needs input state");
		await expectAttentionDot(workspace);
		await expand.click();
		await expectAttentionDot(project);
		await expand.click();
		await expectAttentionDot(workspace);
		await goProjectHome(page);
		await expectNoCompletionMarker(workspace);
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "needs input state");
		await expectAttentionDot(workspace);
		const chatTab = page.getByTestId("editor-tab").filter({ hasText: "needs input state" });
		await chatTab.getByTestId("editor-tab-close").click();
		await expectNoCompletionMarker(workspace);
		await workspace.getByRole("treeitem").click();
		await expect(workspace).toHaveAttribute("data-active", "true");
		await expectNoCompletionMarker(workspace);
		await openPersistedChat(page, "needs input state");
		await expectAttentionDot(workspace);
	} finally {
		rmSync(session.path, { force: true });
	}
});

test("entering a workspace clears its visible unread result without a chat click", async ({
	page,
}) => {
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "workspace entry receipt",
		messages: [
			{ role: "user", text: "Finish before workspace entry.", timestamp: BASE_TS + 5 },
			{ role: "assistant", text: "Visible workspace result.", timestamp: BASE_TS + 6 },
		],
	});
	try {
		await reconnectWithSeed(page);
		const workspace = defaultWorkspaceRow(page);
		await expectNoCompletionMarker(workspace);

		await enterDefaultWorkspace(page);
		await expect(page.getByText("Visible workspace result.", { exact: true })).toBeVisible();
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);
	} finally {
		rmSync(session.path, { force: true });
	}
});

test("marking a workspace unread relights its result until the chat is left, and mark as read clears it", async ({
	page,
}) => {
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "mark unread receipt",
		messages: [
			{ role: "user", text: "Finish before marking.", timestamp: BASE_TS + 7 },
			{ role: "assistant", text: "Result to revisit.", timestamp: BASE_TS + 8 },
		],
	});
	try {
		await reconnectWithSeed(page);
		const workspace = defaultWorkspaceRow(page);
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "mark unread receipt");
		await expect(page.getByText("Result to revisit.", { exact: true })).toBeVisible();
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);

		await openWorkspaceMenu(workspace);
		await expect(page.getByTestId("workspace-mark-read")).toHaveCount(0);
		await page.getByTestId("workspace-mark-unread").click();
		await expectNoCompletionMarker(workspace);
		await settleFrames(page);
		await expectNoCompletionMarker(workspace);

		await page.getByTestId("scope-workspace").click();
		await expect(page.getByTestId("scope-workspace-mark-unread")).toHaveCount(0);
		await page.getByTestId("scope-workspace-mark-read").click();
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);

		await page.getByTestId("scope-workspace").click();
		await page.getByTestId("scope-workspace-mark-unread").click();
		await expectNoCompletionMarker(workspace);
		await goProjectHome(page);
		await expectNoCompletionMarker(workspace);
		await workspace.getByTestId("workspace-name").click();
		await expect(page.getByText("Result to revisit.", { exact: true })).toBeVisible();
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);
	} finally {
		rmSync(session.path, { force: true });
	}
});

test("opening an unread finished chat at its latest edge clears it for every client", async ({
	page,
}) => {
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "finished state receipt",
		messages: [
			{ role: "user", text: "Finish this run.", timestamp: BASE_TS + 10 },
			{ role: "assistant", text: "Finished result.", timestamp: BASE_TS + 11 },
		],
	});
	const quietSibling = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "quiet sibling",
		messages: [],
	});
	try {
		await reconnectWithSeed(page);
		const project = page.getByTestId("project-item").first();
		const workspace = defaultWorkspaceRow(page);
		await expectNoCompletionMarker(workspace);
		await expect(project.getByTestId("project-expand")).toHaveAttribute("data-expanded", "true");
		await project.getByTestId("project-expand").click();
		await expectNoCompletionMarker(project);
		const peer = await page.context().newPage();
		await peer.goto("/");
		await expect(peer.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		const peerProject = peer.getByTestId("project-item").first();
		const peerExpand = peerProject.getByTestId("project-expand");
		if ((await peerExpand.getAttribute("data-expanded")) === "true") await peerExpand.click();
		await expectNoCompletionMarker(peerProject);

		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "finished state receipt");
		await expect(page.getByText("Finished result.", { exact: true })).toBeVisible();
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);
		const projectExpand = project.getByTestId("project-expand");
		if ((await projectExpand.getAttribute("data-expanded")) === "true") await projectExpand.click();
		await expect(project).not.toHaveAttribute("data-attention", /.+/);
		await expect(peerProject).not.toHaveAttribute("data-attention", /.+/);
		await peer.close();
	} finally {
		rmSync(session.path, { force: true });
		rmSync(quietSibling.path, { force: true });
	}
});

function recordAcknowledgements(page: Page): () => number {
	let sent = 0;
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			if (String(payload).includes("session.acknowledgeCompletion")) sent += 1;
		});
	});
	return () => sent;
}

async function settleFrames(page: Page): Promise<void> {
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	);
}

test("an unread result clears only once its chat is seen at the latest edge of a focused window", async ({
	page,
}) => {
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "seen state receipt",
		messages: Array.from({ length: 30 }, (_, index) => [
			{
				role: "user" as const,
				text: `seen request ${index + 1}`,
				timestamp: BASE_TS + 40 + index * 2,
			},
			{
				role: "assistant" as const,
				text: `seen answer ${index + 1}`,
				timestamp: BASE_TS + 41 + index * 2,
			},
		]).flat(),
	});
	const acknowledgements = recordAcknowledgements(page);
	try {
		await reconnectWithSeed(page);
		const workspace = defaultWorkspaceRow(page);
		await expectNoCompletionMarker(workspace);

		await setWindowFocus(page, false);
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "seen state receipt");
		const chatScroll = page.getByTestId("chat-scroll");
		await expect(page.getByText("seen answer 30", { exact: true })).toBeVisible();
		await expect(chatScroll).toHaveAttribute("data-follow-state", "following");
		await settleFrames(page);
		expect(acknowledgements()).toBe(0);
		await expectNoCompletionMarker(workspace);

		await chatScroll.evaluate((root) => {
			const scroller = root.querySelector<HTMLElement>("[data-virtuoso-scroller]");
			if (!scroller) throw new Error("missing Virtuoso scroller");
			scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -900 }));
			scroller.scrollTop = 300;
			scroller.dispatchEvent(new Event("scroll"));
		});
		await expect(chatScroll).toHaveAttribute("data-follow-state", "detached");
		await setWindowFocus(page, true);
		await settleFrames(page);
		expect(acknowledgements()).toBe(0);
		await expectNoCompletionMarker(workspace);

		await page.getByTestId("scroll-to-bottom").click();
		await expect(chatScroll).toHaveAttribute("data-follow-state", "following");
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);
		expect(acknowledgements()).toBe(1);
	} finally {
		rmSync(session.path, { force: true });
	}
});

test("a result finished under the open Resources inspector clears only once the inspector closes", async ({
	page,
}) => {
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "inspector state receipt",
		messages: [
			{ role: "user", text: "Finish behind the inspector.", timestamp: BASE_TS + 120 },
			{ role: "assistant", text: "Covered finished result.", timestamp: BASE_TS + 121 },
		],
	});
	const acknowledgements = recordAcknowledgements(page);
	try {
		await reconnectWithSeed(page);
		const workspace = defaultWorkspaceRow(page);
		await expectNoCompletionMarker(workspace);

		await setWindowFocus(page, false);
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "inspector state receipt");
		await expect(page.getByText("Covered finished result.", { exact: true })).toBeVisible();
		await page.getByTestId("resources-trigger").click();
		const inspector = page.getByTestId("resources-inspector");
		await expect(inspector).toBeVisible();
		await setWindowFocus(page, true);
		await settleFrames(page);
		expect(acknowledgements()).toBe(0);
		await expectNoCompletionMarker(workspace);

		await inspector.getByTestId("resources-inspector-close").click();
		await expect(inspector).toHaveCount(0);
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);
		expect(acknowledgements()).toBe(1);
	} finally {
		rmSync(session.path, { force: true });
	}
});

test("a result behind an open modal clears only once the modal closes", async ({ page }) => {
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "modal state receipt",
		messages: [
			{ role: "user", text: "Finish behind a modal.", timestamp: BASE_TS + 140 },
			{ role: "assistant", text: "Modal-covered finished result.", timestamp: BASE_TS + 141 },
		],
	});
	const acknowledgements = recordAcknowledgements(page);
	try {
		await reconnectWithSeed(page);
		const workspace = defaultWorkspaceRow(page);
		await expectNoCompletionMarker(workspace);

		await setWindowFocus(page, false);
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "modal state receipt");
		await expect(page.getByText("Modal-covered finished result.", { exact: true })).toBeVisible();
		await page.getByTestId("chat-view").evaluate((chat) => {
			const liveRegion = document.createElement("div");
			liveRegion.setAttribute("aria-live", "polite");
			chat.append(liveRegion);
		});
		await page.getByTestId("open-settings").click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await setWindowFocus(page, true);
		await settleFrames(page);
		expect(acknowledgements()).toBe(0);
		await expectNoCompletionMarker(workspace);

		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(workspace).not.toHaveAttribute("data-attention", /.+/);
		expect(acknowledgements()).toBe(1);
	} finally {
		rmSync(session.path, { force: true });
	}
});

test("opening a chat from a sent review comment clears its unread result", async ({ page }) => {
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "sent review attention receipt",
		messages: [
			{ role: "user", text: "Finish this review run.", timestamp: BASE_TS + 20 },
			{ role: "assistant", text: "Review-opened finished result.", timestamp: BASE_TS + 21 },
		],
	});
	const quietSibling = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "quiet sent review sibling",
		messages: [],
	});
	let peer: Page | undefined;
	try {
		await reconnectWithSeed(page);
		const workspace = defaultWorkspaceRow(page);
		await expectNoCompletionMarker(workspace);

		peer = await page.context().newPage();
		await peer.goto("/");
		await expect(peer.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		const peerProject = peer.getByTestId("project-item").first();
		const peerExpand = peerProject.getByTestId("project-expand");
		if ((await peerExpand.getAttribute("data-expanded")) === "true") await peerExpand.click();
		await expectNoCompletionMarker(peerProject);

		await seedSentReviewComment(page, session.id);
		await enterDefaultWorkspace(page);
		const targetChatTab = page.locator(
			`[data-testid="editor-tab"][data-kind="chat"][data-session-id="${session.id}"]`,
		);
		await expect(targetChatTab).toHaveCount(0);
		await expect(
			page.getByTestId("chat-message").filter({ hasText: "Review-opened finished result." }),
		).toHaveCount(0);
		await expectNoCompletionMarker(peerProject);

		await revealWorkbenchTool(page, "review");
		await expect(page.getByTestId("review-panel")).toBeVisible();
		const section = page
			.getByTestId("review-file-section")
			.filter({ has: page.getByTestId("review-file-row").filter({ hasText: "Whole change set" }) });
		if ((await section.getAttribute("data-expanded")) !== "true") {
			await section.getByTestId("review-file-row").click();
		}
		const sentComment = page
			.getByTestId("review-comment")
			.filter({ hasText: "Open the finished review result." });
		await expect(sentComment).toHaveAttribute("data-status", "sent");
		await sentComment.getByTestId("review-comment-open").click();

		await expect(targetChatTab).toHaveAttribute("data-active", "true", { timeout: 30_000 });
		await expect(
			page.getByTestId("chat-message").filter({ hasText: "Review-opened finished result." }),
		).toBeVisible({ timeout: 30_000 });
		await expect(peerProject.getByTestId("attention-dot")).toHaveCount(0, { timeout: 30_000 });
	} finally {
		await peer?.close();
		rmSync(session.path, { force: true });
		rmSync(quietSibling.path, { force: true });
	}
});
