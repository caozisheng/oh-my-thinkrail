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
 * The label a group's rail row shows: the member's relative path, or the project name for the
 * root repository (path `""`).
 */
export function groupMemberLabel(project: Project): string {
	return memberPath(project) || project.name;
}

function compareMembers(a: Project, b: Project): number {
	const left = memberPath(a);
	const right = memberPath(b);
	if (left === right) return 0;
	if (left === "") return -1;
	if (right === "") return 1;
	return left.localeCompare(right);
}

/**
 * The rail's top-level entries: a group of two or more open members sits where its first member
 * appears in the incoming order, as a flat list (root first, then the others by relative path);
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
			projects: [...list].sort(compareMembers),
		});
	}
	return entries;
}
