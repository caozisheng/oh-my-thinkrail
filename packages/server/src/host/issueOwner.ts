import {
	isRepositoryProject,
	PROJECT_GROUP_MAX_REPOSITORIES,
	type Project,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { getProjects, projectGroupMembers, projectGroupProjects } from "../projects";

function unavailable(): never {
	throw new CodedError(
		"RESOURCE_UNAVAILABLE",
		"Issue action is unavailable or requires reconciliation.",
	);
}

export function readIssueOwner(projectId: string): Project {
	const project = getProjects().find((project) => project.id === projectId);
	if (
		!project ||
		project.closed ||
		(project.kind !== "group" && (!isRepositoryProject(project) || project.trusted !== true))
	)
		unavailable();
	return project;
}

export function readIssueRepository(owner: Project, projectId: string): Project {
	const project = readIssueOwner(projectId);
	if (
		!isRepositoryProject(project) ||
		(owner.kind === "group" && project.projectGroup?.id !== owner.id)
	)
		unavailable();
	return project;
}

export function issueReferenceCandidates(projectId: string): string[] {
	const owner = getProjects().find((project) => project.id === projectId);
	return (
		owner?.kind === "group" ? projectGroupProjects(projectId) : projectGroupMembers(projectId)
	)
		.filter((project) => project.trusted === true)
		.slice(0, PROJECT_GROUP_MAX_REPOSITORIES)
		.map((project) => project.id);
}
