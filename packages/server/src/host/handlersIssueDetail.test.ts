import { expect, spyOn, test } from "bun:test";
import { handleRequest } from "./handlers";
import * as issues from "./issues";

test("detail refuses older clients before delegation and accepts exact targets at v114", async () => {
	const reference = {
		provider: "github" as const,
		instanceUrl: "https://github.com",
		projectId: "7",
		number: 24,
	};
	const params = { projectId: "local", reference };
	const result = {
		reference,
		title: "Title",
		description: "Body",
		url: "https://github.com/team/repo/issues/24",
		comments: [],
		fetchedAt: "2026-01-01T00:00:00Z",
	};
	const spy = spyOn(issues, "issuesDetail").mockResolvedValue(result);
	try {
		await expect(
			handleRequest("issues.detail", params, { clientKey: "detail-test", protocolVersion: 113 }),
		).rejects.toThrow("Issue details are unavailable for this protocol version.");
		expect(spy).not.toHaveBeenCalled();
		expect(
			await handleRequest("issues.detail", params, {
				clientKey: "detail-test",
				protocolVersion: 114,
			}),
		).toEqual(result);
		expect(spy).toHaveBeenCalledWith(params);
	} finally {
		spy.mockRestore();
	}
});
test("detail rejects extra credential keys before project lookup", async () => {
	await expect(
		issues.issuesDetail({
			projectId: "local",
			reference: {
				provider: "github",
				instanceUrl: "https://github.com",
				projectId: "7",
				number: 24,
			},
			token: "never-accepted",
		}),
	).rejects.toThrow("Invalid Issue request.");
});
