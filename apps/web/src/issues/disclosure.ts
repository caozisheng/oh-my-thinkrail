import type { IssueStage } from "@thinkrail/contracts";

export type IssueDisclosure = Record<IssueStage, boolean>;
export interface IssueDisclosureIdentity {
	endpoint: string;
	instanceUrl: string;
	projectId: string;
	remoteProjectId: string;
}

export const expandedIssueDisclosure = (): IssueDisclosure => ({
	backlog: true,
	"in-progress": true,
	"in-review": true,
	closed: true,
});

export function issueDisclosureKey(identity: IssueDisclosureIdentity): string {
	return `thinkrail:issues:disclosure:${JSON.stringify([
		identity.endpoint,
		identity.instanceUrl,
		identity.projectId,
		identity.remoteProjectId,
	])}`;
}

export function readIssueDisclosure(
	storage: Pick<Storage, "getItem">,
	key: string,
): IssueDisclosure {
	try {
		const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return expandedIssueDisclosure();
		const record = value as Record<string, unknown>;
		if (
			["backlog", "in-progress", "in-review", "closed"].some(
				(stage) => typeof record[stage] !== "boolean",
			)
		)
			return expandedIssueDisclosure();
		return {
			backlog: record.backlog as boolean,
			"in-progress": record["in-progress"] as boolean,
			"in-review": record["in-review"] as boolean,
			closed: record.closed as boolean,
		};
	} catch {
		return expandedIssueDisclosure();
	}
}

export function writeIssueDisclosure(
	storage: Pick<Storage, "setItem">,
	key: string,
	value: IssueDisclosure,
): void {
	try {
		storage.setItem(key, JSON.stringify(value));
	} catch {
		// The panel remains usable with its in-memory state when browser storage is unavailable.
	}
}
