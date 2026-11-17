import { isAbsolute, resolve } from "node:path";
import type { IssueWorkspaceRecord, WorkspaceHandle } from "./workspace";

type CompletedWorkspace = Extract<
	NonNullable<IssueWorkspaceRecord["implementation"]>,
	{ state: "completed" }
>;

export function createWorkspaceOwner(options: {
	kind: "group" | undefined;
	projectId: string;
	root: () => Promise<string>;
	defaultWorkspace: () => WorkspaceHandle | Promise<WorkspaceHandle>;
	refuse: () => never;
}) {
	const group = options.kind === "group";
	const { projectId, refuse } = options;
	async function defaultWorkspace(): Promise<WorkspaceHandle> {
		const workspace = await options.defaultWorkspace();
		if (
			!workspace.id ||
			workspace.projectId !== projectId ||
			workspace.kind !== (group ? "group" : "default") ||
			!isAbsolute(workspace.worktreePath) ||
			resolve(workspace.worktreePath) !== (await options.root()) ||
			(group && workspace.branch !== "")
		)
			return refuse();
		return workspace;
	}
	return {
		kind: options.kind,
		primaryRepositoryIds: group ? [] : [projectId],
		lockKey: (identity: string, number: number) =>
			group ? identity : JSON.stringify([projectId, number]),
		defaultWorkspace,
		async implementation(
			record: IssueWorkspaceRecord,
			prepareRepository: () => Promise<CompletedWorkspace>,
		): Promise<CompletedWorkspace> {
			if (!group) return prepareRepository();
			const workspace = await defaultWorkspace();
			const previous = record.implementation;
			if (
				previous &&
				(previous.state !== "completed" ||
					previous.workspaceId !== workspace.id ||
					!isAbsolute(previous.worktreePath) ||
					resolve(previous.worktreePath) !== workspace.worktreePath ||
					previous.branch !== "")
			)
				return refuse();
			return (
				previous ?? {
					state: "completed",
					workspaceId: workspace.id,
					worktreePath: workspace.worktreePath,
					branch: "",
				}
			);
		},
	};
}
