import { expect, test } from "bun:test";
import { assertNoE2eHost } from "../e2e/fixtures/isolation";

test("prelaunch accepts a refused localhost endpoint", async () => {
	await expect(assertNoE2eHost(1)).resolves.toBeUndefined();
});
