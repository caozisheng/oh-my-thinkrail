import { STORAGE_PREFIX } from "../constants/branding";
import { useAppStore } from "../store";
import { getTransport } from "../transport";

function storageKey(name: string): string {
	return `${STORAGE_PREFIX}${name}:${getTransport().httpBase()}`;
}

function readPersistedKeys(name: string): string[] {
	try {
		const raw = localStorage.getItem(storageKey(name));
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string");
	} catch {
		return [];
	}
}

function persistKeys(name: string, keys: Record<string, true>): void {
	try {
		localStorage.setItem(storageKey(name), JSON.stringify(Object.keys(keys)));
	} catch {}
}

const EXPANDED_PROJECTS = "expanded-projects";
const COLLAPSED_RAIL_NODES = "collapsed-rail-nodes";

export function initProjectExpansionPersistence(): void {
	const store = useAppStore.getState();
	store.hydrateExpandedProjects(readPersistedKeys(EXPANDED_PROJECTS));
	store.hydrateCollapsedRailNodes(readPersistedKeys(COLLAPSED_RAIL_NODES));
	let previous = useAppStore.getState().expandedProjectIds;
	let previousCollapsed = useAppStore.getState().collapsedRailNodes;
	useAppStore.subscribe((state) => {
		if (state.expandedProjectIds !== previous) {
			previous = state.expandedProjectIds;
			persistKeys(EXPANDED_PROJECTS, previous);
		}
		if (state.collapsedRailNodes !== previousCollapsed) {
			previousCollapsed = state.collapsedRailNodes;
			persistKeys(COLLAPSED_RAIL_NODES, previousCollapsed);
		}
	});
}
