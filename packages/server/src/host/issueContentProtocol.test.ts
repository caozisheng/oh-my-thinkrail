import { expect, spyOn, test } from "bun:test";
import { ISSUES_CONTENT_PROTOCOL_VERSION, type IssueTarget } from "@thinkrail/contracts";
import { handleRequest } from "./handlers";
import * as issues from "./issues";

test("body RPC rejects old protocols before delegation", async () => {
	const target: IssueTarget = {
		projectId: "local",
		reference: {
			provider: "github",
			instanceUrl: "https://github.com",
			projectId: "7",
			number: 42,
		},
	};
	const result = { description: "Body", url: "https://github.com/team/repo/issues/42" };
	const read = spyOn(issues, "issuesContent").mockResolvedValue(result);
	try {
		await expect(
			handleRequest("issues.content", target, {
				clientKey: "fixture",
				protocolVersion: ISSUES_CONTENT_PROTOCOL_VERSION - 1,
			}),
		).rejects.toThrow("newer protocol");
		expect(read).not.toHaveBeenCalled();
		for (const protocolVersion of [ISSUES_CONTENT_PROTOCOL_VERSION, undefined]) {
			expect(
				await handleRequest("issues.content", target, {
					clientKey: "fixture",
					...(protocolVersion === undefined ? {} : { protocolVersion }),
				}),
			).toEqual(result);
		}
		expect(read).toHaveBeenCalledTimes(2);
	} finally {
		read.mockRestore();
	}
});
