import type { Project, Workspace } from "./domain";

const REPOSITORY = { git: true, specs: true, issues: true } as const;
const CAPABILITIES = {
	managed: REPOSITORY,
	default: REPOSITORY,
	external: REPOSITORY,
	chat: { git: false, specs: false, issues: false },
	group: { git: false, specs: true, issues: true },
} as const;

export function workspaceCapabilities(workspace: Pick<Workspace, "kind">) {
	return CAPABILITIES[workspace.kind ?? "managed"];
}

export function isRepositoryWorkspace(workspace: Pick<Workspace, "kind">): boolean {
	return workspaceCapabilities(workspace).git;
}

export function isRepositoryProject(project: Pick<Project, "kind">): boolean {
	return project.kind === undefined;
}
