import { expect, test } from "bun:test";
import type { IssueReference } from "@thinkrail/contracts";
import { createIssuesService } from "./index";

for (const provider of ["github", "gitlab"] as const) {
	test(`${provider} body read checks binding and never reads comments`, async () => {
		const instanceUrl = provider === "github" ? "https://github.com" : "https://gitlab.example";
		const reference: IssueReference = { provider, instanceUrl, projectId: "7", number: 42 };
		const requests: string[] = [];
		let hold: (() => void) | undefined;
		let started: (() => void) | undefined;
		const service = await createIssuesService({
			persistence: { load: async () => [], save: async () => {} },
			credentialStore: { get: async () => null, set: async () => {}, delete: async () => {} },
			fetch: async (url) => {
				requests.push(url);
				if (url.endsWith("/issues/42")) {
					if (started) {
						started();
						await new Promise<void>((resolve) => {
							hold = resolve;
						});
					}
					return Response.json(
						provider === "github"
							? {
									number: 42,
									title: "Body",
									body: "**Details**",
									state: "closed",
									labels: [],
									updated_at: "2026-01-01T00:00:00Z",
									html_url: "https://github.com/team/repo/issues/42",
								}
							: {
									iid: 42,
									title: "Body",
									description: "**Details**",
									state: "closed",
									labels: [],
									updated_at: "2026-01-01T00:00:00Z",
								},
					);
				}
				return Response.json(
					provider === "github"
						? {
								id: 7,
								full_name: "team/repo",
								default_branch: "main",
								clone_url: "https://github.com/team/repo.git",
								ssh_url: "git@github.com:team/repo.git",
							}
						: { id: 7, path_with_namespace: "team/repo" },
				);
			},
		});
		await service.connect("local", { instanceUrl, projectId: "team/repo", token: "fixture-token" });
		for (const patch of [
			{ projectId: "8" },
			{ instanceUrl: "https://other.example" },
			{ provider: provider === "github" ? ("gitlab" as const) : ("github" as const) },
		]) {
			await expect(service.content("local", { ...reference, ...patch })).rejects.toThrow();
		}
		expect(requests).toHaveLength(1);
		expect(await service.content("local", reference)).toEqual({
			description: "**Details**",
			url: `${instanceUrl}/team/repo/${provider === "gitlab" ? "-/" : ""}issues/42`,
		});
		expect(requests).toHaveLength(2);
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = service.content("local", reference);
		await reading;
		await service.disconnect("local");
		hold?.();
		await expect(pending).rejects.toThrow("connection changed");
		await expect(service.content("local", reference)).rejects.toThrow();
		expect(requests.every((url) => !url.includes("notes") && !url.includes("comments"))).toBe(true);
	});
}
