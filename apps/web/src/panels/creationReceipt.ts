import type { WorkspaceCreation } from "@thinkrail/contracts";
import { type CreationChatHandoff, useAppStore } from "../store";
import { getTransport } from "../transport";

export async function reconcileCreationReceipt(
	receipt: WorkspaceCreation,
	options: { select?: boolean; sentPrompt?: CreationChatHandoff["sentPrompt"] } = {},
): Promise<void> {
	const store = useAppStore.getState();
	if (options.sentPrompt) store.rememberCreationPrompt(receipt.id, options.sentPrompt);
	if (options.select) {
		store.expandProject(receipt.projectId);
		store.selectCreation(receipt.id);
	}
	const read = useAppStore.getState();
	const [creations, workspaces] = await Promise.all([
		getTransport().request("workspace.listCreations", {}),
		getTransport().request("workspace.list", { projectId: receipt.projectId }),
	]);
	useAppStore.getState().reconcileCreationReceipt(read, receipt.projectId, creations, workspaces);
	const current = useAppStore.getState();
	if (
		!options.select ||
		current.connectionGeneration !== read.connectionGeneration ||
		current.selectedProjectId !== read.selectedProjectId ||
		current.activeWorkspaceId !== read.activeWorkspaceId ||
		(current.activeCreationId !== read.activeCreationId && current.activeCreationId !== receipt.id)
	)
		return;
	if (current.workspaceCreations[receipt.id]) current.selectCreation(receipt.id);
	else {
		const workspace = current.workspaces[receipt.projectId]?.find((w) => w.id === receipt.id);
		if (workspace) current.activateWorkspace(workspace);
	}
}
