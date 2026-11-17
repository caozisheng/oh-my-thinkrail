import { expect, test } from "bun:test";
import { isRepositoryProject, isRepositoryWorkspace, workspaceCapabilities } from "./index";

test("group workspaces expose shared tools without repository authority", () => {
	expect(workspaceCapabilities({ kind: "group" })).toEqual({
		git: false,
		specs: true,
		issues: true,
	});
	expect(isRepositoryWorkspace({ kind: "group" })).toBe(false);
	expect(isRepositoryProject({ kind: "group" })).toBe(false);
});

test("repository workspaces retain Git while projectless chats remain separate", () => {
	for (const workspace of [{}, { kind: "default" }, { kind: "external" }] as const) {
		expect(isRepositoryWorkspace(workspace)).toBe(true);
		expect(workspaceCapabilities(workspace)).toEqual({ git: true, specs: true, issues: true });
	}
	expect(workspaceCapabilities({ kind: "chat" })).toEqual({
		git: false,
		specs: false,
		issues: false,
	});
	expect(isRepositoryWorkspace({ kind: "chat" })).toBe(false);
	expect(isRepositoryProject({ kind: "chats" })).toBe(false);
	expect(isRepositoryProject({})).toBe(true);
});
