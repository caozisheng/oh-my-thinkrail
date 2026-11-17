import { randomUUID } from "node:crypto";
import type { Project, Workspace } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { loadWorkspaces, saveWorkspaces } from "../persistence";

export function ensureGroupWorkspaceRecord(
	project: Project,
	publish: (event: { kind: "created"; workspace: Workspace }) => void,
): Workspace {
	if (project.kind !== "group")
		throw new CodedError("RESOURCE_UNAVAILABLE", "Not a group context.");
	const all = loadWorkspaces();
	const existing = all.find(
		(workspace) => workspace.projectId === project.id && workspace.kind === "group",
	);
	if (existing) return existing;
	const workspace: Workspace = {
		id: randomUUID(),
		projectId: project.id,
		kind: "group",
		name: project.name,
		branch: "",
		baseBranch: "",
		worktreePath: project.path,
		renamed: true,
		initialTerminalPending: true,
	};
	all.push(workspace);
	saveWorkspaces(all);
	publish({ kind: "created", workspace });
	return workspace;
}
