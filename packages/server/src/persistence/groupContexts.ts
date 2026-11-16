import { isAbsolute } from "node:path";
import type { Project, Workspace } from "@thinkrail/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isAbsolutePath = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && isAbsolute(value);
type GroupContexts = { version: 1; projects: Project[]; workspaces: Workspace[] };

export function createGroupContextStore(read: () => string, write: (value: GroupContexts) => void) {
	function load(): GroupContexts {
		let raw: unknown;
		try {
			raw = JSON.parse(read());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, projects: [], workspaces: [] };
			throw error;
		}
		if (
			!isRecord(raw) ||
			raw.version !== 1 ||
			!Array.isArray(raw.projects) ||
			!Array.isArray(raw.workspaces) ||
			!raw.projects.every(
				(project) =>
					isRecord(project) &&
					project.kind === "group" &&
					typeof project.id === "string" &&
					isAbsolutePath(project.path) &&
					typeof project.name === "string" &&
					typeof project.slug === "string" &&
					Number.isFinite(project.lastOpened),
			) ||
			!raw.workspaces.every(
				(workspace) =>
					isRecord(workspace) &&
					workspace.kind === "group" &&
					typeof workspace.id === "string" &&
					typeof workspace.projectId === "string" &&
					isAbsolutePath(workspace.worktreePath) &&
					typeof workspace.name === "string" &&
					workspace.branch === "" &&
					workspace.baseBranch === "",
			)
		)
			throw new Error("Unsupported or malformed group contexts store.");
		return raw as GroupContexts;
	}

	return {
		projects: () => load().projects,
		workspaces: () => load().workspaces,
		partitionProjects(projects: Project[]): Project[] {
			const current = load();
			const contexts = projects.filter((project) => project.kind === "group");
			if (contexts.length || current.projects.length) write({ ...current, projects: contexts });
			return projects.filter((project) => project.kind !== "group");
		},
		partitionWorkspaces(workspaces: Workspace[]): Workspace[] {
			const current = load();
			const contexts = workspaces.filter((workspace) => workspace.kind === "group");
			if (contexts.length || current.workspaces.length) write({ ...current, workspaces: contexts });
			return workspaces.filter((workspace) => workspace.kind !== "group");
		},
	};
}
