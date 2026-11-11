import type { Project } from "@thinkrail/contracts";

export type ProjectRailEntry =
	| { kind: "project"; project: Project }
	| {
			kind: "group";
			id: string;
			name: string;
			root: string;
			projects: Project[];
	  };

function memberPath(project: Project): string {
	return project.projectGroup?.path ?? "";
}

/** The rail key a group header's collapse state is stored under. */
export function groupNodeKey(groupId: string): string {
	return `group:${groupId}`;
}

/**
 * The label a group's rail row shows: the member's relative path. A group folder that is itself a
 * repository (path `""`, e.g. a submodule superproject) is an ordinary member labelled `.`.
 */
export function groupMemberLabel(project: Project): string {
	return memberPath(project) || ".";
}

/** Members sort by relative path only; no member is special. */
export function compareGroupMembers(a: Project, b: Project): number {
	return groupMemberLabel(a).localeCompare(groupMemberLabel(b));
}

/**
 * The rail's top-level entries: a group of two or more open members sits where its first member
 * appears in the incoming order, as a flat list sorted by relative path;
 * everything else stays a plain row.
 */
export function projectRailEntries(projects: readonly Project[]): ProjectRailEntry[] {
	const members = new Map<string, Project[]>();
	for (const project of projects) {
		const group = project.projectGroup;
		if (group) members.set(group.id, [...(members.get(group.id) ?? []), project]);
	}
	const entries: ProjectRailEntry[] = [];
	const placed = new Set<string>();
	for (const project of projects) {
		const group = project.projectGroup;
		const list = group ? (members.get(group.id) ?? []) : [];
		if (!group || list.length < 2) {
			entries.push({ kind: "project", project });
			continue;
		}
		if (placed.has(group.id)) continue;
		placed.add(group.id);
		entries.push({
			kind: "group",
			id: group.id,
			name: group.name,
			root: group.root,
			projects: [...list].sort(compareGroupMembers),
		});
	}
	return entries;
}
