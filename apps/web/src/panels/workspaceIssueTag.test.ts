import { expect, test } from "bun:test";
import type { WorkspaceIssueBinding } from "@thinkrail/contracts";
import { workspaceIssueTagText } from "./workspaceIssueTag";

const binding = (
	role: WorkspaceIssueBinding["role"],
	hasAssociations: boolean,
): WorkspaceIssueBinding => ({
	provider: "github",
	instanceUrl: "https://github.com",
	number: 23,
	role,
	hasAssociations,
});

test("the primary of an issue with associated repositories marks itself", () => {
	expect(workspaceIssueTagText(binding("primary", true))).toBe("#23(master)");
});

test("a single-repository issue and every associated workspace keep the bare number", () => {
	expect(workspaceIssueTagText(binding("primary", false))).toBe("#23");
	expect(workspaceIssueTagText(binding("associated", true))).toBe("#23");
});
