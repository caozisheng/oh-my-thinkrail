import { expect, test } from "bun:test";
import { createGitLabClient } from "./client";
import { createGitHubClient } from "./github";

for (const provider of ["github", "gitlab"] as const) {
	function fixture(status = 204, foreign = false) {
		const calls: { url: string; method: string }[] = [];
		const fetch = async (url: string, init: RequestInit) => {
			const method = init.method ?? "GET";
			calls.push({ url, method });
			if (method === "DELETE") return new Response(null, { status });
			if (url.endsWith("/repos/octo/app"))
				return Response.json({
					id: 42,
					full_name: "octo/app",
					default_branch: null,
					clone_url: null,
					ssh_url: null,
				});
			return Response.json(
				provider === "github"
					? {
							id: 12,
							body: "note",
							created_at: "2026-01-01",
							issue_url: `https://api.github.com/repos/octo/app/issues/${foreign ? 8 : 7}`,
						}
					: { id: 12, body: "note", created_at: "2026-01-01", system: false },
			);
		};
		const remote =
			provider === "github"
				? createGitHubClient({
						instanceUrl: "https://github.com",
						project: "octo/app",
						token: "fixture-secret",
						fetch,
					})
				: createGitLabClient({
						instanceUrl: "https://gitlab.example",
						project: "42",
						token: "fixture-secret",
						fetch,
					});
		return { remote, calls };
	}
	test(`${provider} deletes only the verified comment with one empty 204 write`, async () => {
		const { remote, calls } = fixture();
		if (!remote.deleteNote) throw new Error("deleteNote unavailable");
		await remote.deleteNote(7, 12);
		expect(calls.map((c) => c.method)).toEqual(
			provider === "github" ? ["GET", "GET", "DELETE"] : ["GET", "DELETE"],
		);
		expect(calls.at(-1)?.url).toEndWith(
			provider === "github" ? "/issues/comments/12" : "/issues/7/notes/12",
		);
	});
	test(`${provider} validates identifiers before requests and never retries a failed delete`, async () => {
		const { remote, calls } = fixture(500);
		if (!remote.deleteNote) throw new Error("deleteNote unavailable");
		await expect(remote.deleteNote(7, 0)).rejects.toThrow();
		expect(calls).toHaveLength(0);
		await expect(remote.deleteNote(7, 12)).rejects.toThrow();
		expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
	});
	if (provider === "github")
		test("GitHub rejects comments from another Issue before deletion", async () => {
			const { remote, calls } = fixture(204, true);
			if (!remote.deleteNote) throw new Error("deleteNote unavailable");
			await expect(remote.deleteNote(7, 12)).rejects.toThrow();
			expect(calls.every((c) => c.method === "GET")).toBe(true);
		});
}
