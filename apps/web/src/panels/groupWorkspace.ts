import type { IssueReference } from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { startChatInTab } from "./openChat";

export async function openGroupWorkspace(
	groupId: string,
	view: "default" | "chat" | "terminal" | "issues" | "specs",
	draft?: string,
) {
	const before = useAppStore.getState();
	const { project, workspace } = await getTransport().request("project.openGroup", { groupId });
	const store = useAppStore.getState();
	if (
		store.connectionGeneration !== before.connectionGeneration ||
		store.activeWorkspaceId !== before.activeWorkspaceId ||
		store.activeProjectGroupId !== before.activeProjectGroupId ||
		store.selectedProjectId !== before.selectedProjectId
	)
		return;
	store.activateGroupWorkspace(project, workspace);
	if (view === "chat") {
		await startChatInTab(workspace.id, draft === undefined ? {} : { draft });
	} else if (view === "terminal") {
		store.addTerminal(workspace.id);
	} else if (view !== "default") {
		store.enqueueLayoutIntent({ kind: "reveal-tool", workspaceId: workspace.id, tool: view });
	}
}

export async function discussGroupIssue(
	workspaceId: string,
	groupId: string,
	reference: IssueReference,
) {
	const detail = await getTransport().request("issues.detail", { projectId: groupId, reference });
	await startChatInTab(workspaceId, {
		draft: t("panels.groupHome.issueDraft", {
			title: detail.title,
			url: detail.url,
			description: detail.description,
		}),
	});
}
