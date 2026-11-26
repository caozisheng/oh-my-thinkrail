import { expect, test } from "bun:test";
import {
	ISSUES_GROUPS_PROTOCOL_VERSION,
	type IssueSummary,
	isIssueConnectionInput,
} from "@thinkrail/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { issueDisclosureKey } from "./disclosure";
import { IssuesPanel } from "./IssuesPanel";
import {
	associationFormState,
	filterIssues,
	issueConnectionInput,
	issueKey,
	resolveIssueConnectionAddress,
	supportsIssueGroups,
} from "./model";

test("people filters combine names and usernames without changing the complete list", () => {
	const base: IssueSummary = {
		reference: {
			provider: "gitlab",
			instanceUrl: "https://forge.example",
			projectId: "7",
			number: 12,
		},
		title: "Task",
		url: "https://forge.example/team/app/-/issues/12",
		labels: [],
		stage: "backlog",
		updatedAt: "2026-01-01T00:00:00Z",
	};
	const alice = { id: 1, name: "张三", username: "Alice" };
	const bob = { id: 2, name: "李四", username: "bob" };
	const rows: IssueSummary[] = [
		{ ...base, assignees: [alice, bob], author: bob },
		{ ...base, assignees: [bob], author: alice },
		{ ...base, assignees: [], author: null },
		base,
	];
	expect(filterIssues(rows, { assignee: "", author: "" })).toBe(rows);
	expect(filterIssues(rows, { assignee: " @aLi ", author: "李四" })).toEqual(rows.slice(0, 1));
	expect(filterIssues(rows, { assignee: "张三", author: "@bob" })).toEqual(rows.slice(0, 1));
	expect(filterIssues(rows, { assignee: "BOB", author: "" })).toEqual(rows.slice(0, 2));
	expect(filterIssues(rows, { assignee: "Alice", author: "Alice" })).toEqual([]);
	expect(rows).toHaveLength(4);
});

test("group URLs derive arbitrary namespaces, nested groups, ports and installation prefixes", () => {
	for (const [address, instance, group] of [
		["https://gitlab.com/groups/research/-/issues", "https://gitlab.com", "research"],
		[
			"http://forge.example:8929/groups/company/mobile/-/issues/",
			"http://forge.example:8929",
			"company/mobile",
		],
		[
			"https://forge.example/scm/gitlab/groups/company/mobile",
			"https://forge.example/scm/gitlab",
			"company/mobile",
		],
	] as const) {
		expect(resolveIssueConnectionAddress(address, instance)).toEqual({
			status: "valid",
			instanceUrl: instance,
			projectId: group,
			scope: "group",
		});
	}
	expect(resolveIssueConnectionAddress("https://forge.example/groups/another/-/issues")).toEqual({
		status: "needs-instance",
		instanceUrl: "https://forge.example",
		projectId: "another",
		scope: "group",
	});
	expect(resolveIssueConnectionAddress("https://github.com/groups/app.git")).toEqual({
		status: "valid",
		instanceUrl: "https://github.com",
		projectId: "groups/app",
	});
	for (const address of [
		"https://gitlab.com/groups/",
		"https://gitlab.com/groups/team/-/members",
		"https://gitlab.com/groups/team/-/issues/more",
		"https://gitlab.com/groups/team/%2e%2e/private/-/issues",
	])
		expect(resolveIssueConnectionAddress(address).status).toBe("invalid");
});

test("group scope requires a capable host and exact HTTP consent before a token can be submitted", () => {
	const fields = {
		connection: null,
		address: "http://forge.example:8929/groups/company/platform/-/issues",
		instanceOverride: null,
		advancedOpen: false,
		acknowledged: null,
		token: "fixture-pat",
		pending: false,
		authSupported: true,
	};
	expect(associationFormState(fields).input).toBeNull();
	const accepted = { ...fields, acknowledged: "http://forge.example:8929" };
	expect(associationFormState(accepted).input).toEqual({
		instanceUrl: "http://forge.example:8929",
		projectId: "company/platform",
		scope: "group",
		token: "fixture-pat",
		httpConsent: { instanceUrl: "http://forge.example:8929" },
	});
	const old = associationFormState({ ...accepted, groupsSupported: false });
	expect(old.canSubmit).toBe(false);
	expect(old.providerNotice).toBe("issues.groupsUnsupported");
	expect(supportsIssueGroups(ISSUES_GROUPS_PROTOCOL_VERSION - 1)).toBe(false);
	expect(supportsIssueGroups(ISSUES_GROUPS_PROTOCOL_VERSION)).toBe(true);
	expect(supportsIssueGroups(null)).toBe(false);
	const connection = {
		projectId: "local",
		instanceUrl: "https://forge.example",
		remoteProjectId: "7",
		scope: "group" as const,
		connected: false,
	};
	expect(associationFormState({ ...fields, connection }).input?.scope).toBe("group");
});

test("scope guards retain project compatibility and reject GitHub groups and malformed scope", () => {
	const input = issueConnectionInput(
		{ instanceUrl: "https://forge.example", projectId: "company", scope: "group" },
		"fixture-pat",
		null,
	);
	expect(input).not.toBeNull();
	expect(isIssueConnectionInput({ ...input, scope: undefined })).toBe(false);
	expect(isIssueConnectionInput({ ...input, scope: "project" })).toBe(false);
	expect(isIssueConnectionInput({ ...input, instanceUrl: "https://github.com" })).toBe(false);
	expect(
		isIssueConnectionInput({
			instanceUrl: "https://forge.example",
			projectId: "company/repo",
			token: "fixture-pat",
		}),
	).toBe(true);
});

test("equal group/project ids and equal Issue IIDs keep separate disclosure and row identities", () => {
	const identity = {
		endpoint: "https://host.example",
		instanceUrl: "https://forge.example",
		projectId: "local",
		remoteProjectId: "7",
	};
	expect(issueDisclosureKey(identity)).not.toBe(
		issueDisclosureKey({ ...identity, scope: "group" }),
	);
	const issues: IssueSummary[] = [7, 9].map((id) => ({
		reference: {
			provider: "gitlab",
			instanceUrl: identity.instanceUrl,
			projectId: String(id),
			number: 12,
		},
		projectPath: `company/project-${id}`,
		title: `Task ${id}`,
		url: `${identity.instanceUrl}/company/project-${id}/-/issues/12`,
		stage: "backlog",
		labels: [],
		updatedAt: "2026-01-01T00:00:00Z",
	}));
	expect(new Set(issues.map(issueKey)).size).toBe(2);
	const html = renderToStaticMarkup(
		createElement(IssuesPanel, {
			connection: { ...identity, scope: "group", connected: true },
			issues,
			pending: false,
			authSupported: true,
			githubSupported: true,
			groupsSupported: true,
			capabilities: { actionsSupported: true, implementationSupported: true, trusted: true },
			onConnect: async () => ({ ok: true as const }),
			onDisconnect: async () => {},
			onRefresh: () => {},
		}),
	);
	expect(html).toContain("company/project-7#12");
	expect(html).toContain("company/project-9#12");
});
