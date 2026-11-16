import { expect, test } from "bun:test";
import { hasIssueProjectTrust, isIssueRepositoryCandidate, type Project } from "./index";

const group = { id: "suite", kind: "group" } as const;
const base: Project = {
	id: "member",
	name: "Member",
	slug: "member",
	path: "/suite/member",
	lastOpened: 1,
	projectGroup: { id: group.id, name: "Suite", root: "/suite", path: "member" },
};

test("Issue admission accepts either explicit grant without changing resource or alias trust", () => {
	for (const grant of [
		{ trusted: true },
		{ piResourceTrust: "granted" as const },
		{ trusted: false, piResourceTrust: "granted" as const },
		{ trusted: true, piResourceTrust: "untrusted" as const },
	]) {
		const project = { ...base, ...grant };
		const before = structuredClone(project);
		expect(hasIssueProjectTrust(project)).toBe(true);
		expect(isIssueRepositoryCandidate(project)).toBe(true);
		expect(isIssueRepositoryCandidate(project, group)).toBe(true);
		expect(project).toEqual(before);
	}
	for (const grant of [
		{},
		{ trusted: false },
		{ piResourceTrust: "untrusted" as const },
		{ trusted: false, piResourceTrust: "untrusted" as const },
	]) {
		expect(hasIssueProjectTrust(grant)).toBe(false);
		expect(isIssueRepositoryCandidate({ ...base, ...grant }, group)).toBe(false);
	}
});

test("trust never bypasses repository kind, closed state or group membership", () => {
	const trusted = { ...base, piResourceTrust: "granted" as const };
	for (const project of [
		{ ...trusted, closed: true as const },
		{ ...trusted, kind: "group" as const },
		{ ...trusted, kind: "chats" as const },
	]) {
		expect(isIssueRepositoryCandidate(project)).toBe(false);
		expect(isIssueRepositoryCandidate(project, group)).toBe(false);
	}
	expect(isIssueRepositoryCandidate(trusted, { id: "other", kind: "group" })).toBe(false);
	const { projectGroup: _membership, ...outside } = trusted;
	expect(isIssueRepositoryCandidate(outside, group)).toBe(false);
	expect(isIssueRepositoryCandidate(outside, { id: "repo" })).toBe(true);
});
