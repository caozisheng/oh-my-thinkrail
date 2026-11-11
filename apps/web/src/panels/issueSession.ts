import type { IssueSessionLaunch, Workspace } from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { toast, useAppStore } from "../store";
import { openChatInTab } from "./openChat";
import { loadProjectWorkspaces } from "./workspaceActions";

/**
 * Opens a host-launched issue session: refresh this project's workspaces so the new or reused
 * worktree is in the store, activate the route onto it, then land its chat in a tab. The host
 * already created the session; this never creates one, prompts one or writes issue state.
 */
export async function openIssueSession(
	projectId: string,
	launch: IssueSessionLaunch,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	let rows: Workspace[];
	try {
		rows = await loadProjectWorkspaces(projectId);
	} catch (error) {
		if (!isCurrent()) return;
		toast.error(t("shell.workbench.issueLaunchFailed"));
		throw error;
	}
	if (!isCurrent()) return;
	const workspace = rows.find((row) => row.id === launch.workspaceId) ?? {
		id: launch.workspaceId,
		projectId,
	};
	useAppStore.getState().activateWorkspaceFromRoute(workspace, launch.sessionId);
	await openChatInTab(launch.workspaceId, launch.sessionId);
	if (!isCurrent()) return;
	const opened = (useAppStore.getState().tabsByWorkspace[launch.workspaceId] ?? []).some(
		(tab) => tab.kind === "chat" && tab.sessionId === launch.sessionId,
	);
	if (!opened) throw new Error("Issue chat navigation failed");
}
