import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Workspace, WorkspaceCreation } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import * as wireTransport from "../transport/wireTransport";
import { reconcileCreationReceipt } from "./creationReceipt";

const initial = useAppStore.getState();
const receipt: WorkspaceCreation = {
	id: "c1",
	projectId: "p1",
	name: "workspace-1",
	branch: "workspace-1",
	baseBranch: "main",
	state: "running",
	phase: "checking-out",
	startedAt: 1,
};
const workspace: Workspace = {
	id: "c1",
	projectId: "p1",
	name: "workspace-1",
	branch: "workspace-1",
	baseBranch: "main",
	worktreePath: "/w/workspace-1",
};
const prompt = { text: "held locally", attachments: [] };
let finishCreations: (rows: WorkspaceCreation[]) => void;
let finishWorkspaces: (rows: Workspace[]) => void;
let restore = () => {};

beforeEach(() => {
	useAppStore.setState(initial, true);
	useAppStore.setState({ selectedProjectId: "p1", workspaces: { p1: [] } });
	const creations = new Promise<WorkspaceCreation[]>((resolve) => {
		finishCreations = resolve;
	});
	const workspaces = new Promise<Workspace[]>((resolve) => {
		finishWorkspaces = resolve;
	});
	const transport = {
		request: (method: string) => (method === "workspace.listCreations" ? creations : workspaces),
	} as unknown as ReturnType<typeof wireTransport.getTransport>;
	const spy = spyOn(wireTransport, "getTransport").mockReturnValue(transport);
	restore = () => spy.mockRestore();
});

afterEach(() => {
	restore();
	useAppStore.setState(initial, true);
});

for (const path of ["start", "retry"] as const) {
	test(`${path}: replayed running receipt after reconnect completion cannot hide the workspace`, async () => {
		const store = useAppStore.getState();
		store.applyWorkspaceCreation({ ...receipt, state: "interrupted" });
		store.selectCreation(receipt.id);
		store.setWorkspaces("p1", [workspace]);
		store.setWorkspaceCreations([]);
		const pending = reconcileCreationReceipt(
			receipt,
			path === "start" ? { select: true, sentPrompt: prompt } : {},
		);
		expect(useAppStore.getState().workspaceCreations).toEqual({});
		finishCreations([]);
		finishWorkspaces([workspace]);
		await pending;
		expect(useAppStore.getState()).toMatchObject({
			workspaceCreations: {},
			activeCreationId: null,
			activeWorkspaceId: receipt.id,
			sentCreationPrompts: {},
		});
	});

	test(`${path}: completion push beats a stale reconciliation read`, async () => {
		const store = useAppStore.getState();
		store.applyWorkspaceCreation(receipt);
		store.selectCreation(receipt.id);
		const pending = reconcileCreationReceipt(
			receipt,
			path === "start" ? { select: true, sentPrompt: prompt } : {},
		);
		store.addWorkspace(workspace);
		store.applyWorkspaceCreationRemoved({ id: receipt.id, projectId: "p1", workspace });
		finishCreations([receipt]);
		finishWorkspaces([]);
		await pending;
		expect(useAppStore.getState()).toMatchObject({
			workspaceCreations: {},
			activeCreationId: null,
			activeWorkspaceId: receipt.id,
			workspaces: { p1: [workspace] },
		});
	});
}

test("a newer failed push survives the read, with the separately held prompt", async () => {
	const pending = reconcileCreationReceipt(receipt, { select: true, sentPrompt: prompt });
	const failed = { ...receipt, state: "failed" as const, failure: { message: "disk full" } };
	useAppStore.getState().applyWorkspaceCreation(failed);
	finishCreations([receipt]);
	finishWorkspaces([]);
	await pending;
	expect(useAppStore.getState().workspaceCreations.c1).toEqual(failed);
	expect(useAppStore.getState().sentCreationPrompts.c1).toEqual(prompt);
});
