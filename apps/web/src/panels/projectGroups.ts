import type { Project } from "@thinkrail/contracts";

/**
 * One row of a group's rail tree. A repository row is an open member; a folder row is a directory
 * between members that is not itself a member, with single-child folder chains folded into one row.
 * `path` is relative to the group root; `label` is the part shown, relative to the parent row.
 */
export type ProjectGroupTreeNode =
	| {
			kind: "repository";
			key: string;
			path: string;
			label: string;
			project: Project;
			children: ProjectGroupTreeNode[];
	  }
	| { kind: "folder"; key: string; path: string; label: string; children: ProjectGroupTreeNode[] };

export type ProjectRailEntry =
	| { kind: "project"; project: Project }
	| {
			kind: "group";
			id: string;
			name: string;
			root: string;
			projects: Project[];
			tree: ProjectGroupTreeNode[];
	  };

function depth(path: string): number {
	return path ? path.split("/").length : 0;
}

function memberPath(project: Project): string {
	return project.projectGroup?.path ?? "";
}

/** The rail key a group header's collapse state is stored under. */
export function groupNodeKey(groupId: string): string {
	return `group:${groupId}`;
}

/** The rail key a folder row's collapse state is stored under. */
export function folderNodeKey(groupId: string, path: string): string {
	return `folder:${groupId}:${path}`;
}

interface Trie {
	segment: string;
	path: string;
	project?: Project;
	children: Map<string, Trie>;
}

function sortedChildren(node: Trie): Trie[] {
	return [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));
}

function toNodes(groupId: string, node: Trie, prefix: string): ProjectGroupTreeNode {
	const label = prefix ? `${prefix}/${node.segment}` : node.segment;
	const children = sortedChildren(node);
	if (node.project) {
		return {
			kind: "repository",
			key: node.project.id,
			path: node.path,
			label,
			project: node.project,
			children: children.map((child) => toNodes(groupId, child, "")),
		};
	}
	const [only] = children;
	if (children.length === 1 && only && !only.project) return toNodes(groupId, only, label);
	return {
		kind: "folder",
		key: folderNodeKey(groupId, node.path),
		path: node.path,
		label,
		children: children.map((child) => toNodes(groupId, child, "")),
	};
}

/**
 * The group's members laid out like the folder they were imported from: the root repository (path
 * `""`) first, then the tree below the root. A member nests under the member that contains it, and
 * plain folders in between become folder rows (a chain of single-child folders folds into one).
 */
export function projectGroupTree(
	groupId: string,
	projects: readonly Project[],
): ProjectGroupTreeNode[] {
	const top: Trie = { segment: "", path: "", children: new Map() };
	let rootProject: Project | undefined;
	for (const project of projects) {
		const path = memberPath(project);
		if (path === "") {
			rootProject ??= project;
			continue;
		}
		let node = top;
		for (const segment of path.split("/")) {
			const childPath = node.path ? `${node.path}/${segment}` : segment;
			let child = node.children.get(segment);
			if (!child) {
				child = { segment, path: childPath, children: new Map() };
				node.children.set(segment, child);
			}
			node = child;
		}
		node.project ??= project;
	}
	const nodes = sortedChildren(top).map((child) => toNodes(groupId, child, ""));
	return rootProject
		? [
				{
					kind: "repository",
					key: rootProject.id,
					path: "",
					label: rootProject.name,
					project: rootProject,
					children: [],
				},
				...nodes,
			]
		: nodes;
}

/** Every repository row at or below `nodes`, in tree order. */
export function treeProjects(nodes: readonly ProjectGroupTreeNode[]): Project[] {
	return nodes.flatMap((node) =>
		node.kind === "repository"
			? [node.project, ...treeProjects(node.children)]
			: treeProjects(node.children),
	);
}

/**
 * The rail's top-level entries: a group of two or more open members sits where its first member
 * appears in the incoming order, as its folder tree; everything else stays a plain row.
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
			projects: [...list].sort(
				(a, b) =>
					depth(memberPath(a)) - depth(memberPath(b)) || memberPath(a).localeCompare(memberPath(b)),
			),
			tree: projectGroupTree(group.id, list),
		});
	}
	return entries;
}
