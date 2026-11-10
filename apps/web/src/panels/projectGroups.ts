import type { Project } from "@thinkrail/contracts";

export type ProjectRailEntry =
	| { kind: "project"; project: Project }
	| { kind: "group"; id: string; name: string; root: string; projects: Project[] };

function depth(path: string): number {
	return path ? path.split("/").length : 0;
}

/**
 * The rail's top-level entries: a group of two or more open members sits where its first member
 * appears in the incoming order, listing members shallow-first; everything else stays a plain row.
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
		const path = (p: Project) => p.projectGroup?.path ?? "";
		entries.push({
			kind: "group",
			id: group.id,
			name: group.name,
			root: group.root,
			projects: [...list].sort(
				(a, b) => depth(path(a)) - depth(path(b)) || path(a).localeCompare(path(b)),
			),
		});
	}
	return entries;
}
