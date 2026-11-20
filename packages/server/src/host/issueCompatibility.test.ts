import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssueCompatibility } from "./issueCompatibility";
import type { IssueDependencyMerge } from "./issueRepositoryDependencies";

const upstream: IssueDependencyMerge = {
	projectId: "upstream-project",
	provider: "github",
	instanceUrl: "https://github.com",
	remoteProjectId: 17,
	iid: 23,
	targetBranch: "main",
	mergeCommitSha: "a".repeat(40),
	targetSha: "b".repeat(40),
	snapshot: "provider-evidence",
};
const coverage = {
	api: "checked",
	abi: "not-applicable",
	protocol: "checked",
	conflict: "checked",
	checks: "not-applicable",
};
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const path = await mkdtemp(join(tmpdir(), "issue-compat-"));
	roots.push(path);
	await mkdir(join(path, ".thinkrail"));
	return path;
}

async function configure(path: string, command: string[], timeoutMs = 2000, covered = coverage) {
	await writeFile(
		join(path, ".thinkrail", "issue-compatibility.json"),
		JSON.stringify({ version: 1, command, timeoutMs, coverage: covered }),
	);
}

function bun(code: string): string[] {
	return [process.execPath, "-e", code];
}

function input(path: string) {
	return {
		path,
		projectId: "downstream-project",
		downstreamSha: "c".repeat(40),
		downstreamTree: "d".repeat(40),
		upstream,
	};
}

async function refusal(path: string, reason: string) {
	try {
		await runIssueCompatibility(input(path));
		throw new Error("expected refusal");
	} catch (error) {
		expect(error).toMatchObject({ code: "ISSUE_DELIVERY_REFUSED" });
		expect((error as Error).message).toContain(reason);
	}
}

describe("runIssueCompatibility", () => {
	test("refuses absent and malformed config", async () => {
		const absent = await fixture();
		await refusal(absent, "compatibility-missing");
		const invalid = await fixture();
		await writeFile(join(invalid, ".thinkrail", "issue-compatibility.json"), "{}");
		await refusal(invalid, "compatibility-invalid");
	});

	test("refuses failed commands without exposing command output", async () => {
		const path = await fixture();
		await configure(path, bun("console.error('sensitive output'); process.exit(9)"));
		try {
			await runIssueCompatibility(input(path));
			throw new Error("expected refusal");
		} catch (error) {
			expect((error as Error).message).toContain("compatibility-failed");
			expect((error as Error).message).not.toContain("sensitive");
		}
	});

	test("kills and awaits timed-out commands", async () => {
		const path = await fixture();
		await configure(path, bun("await Bun.sleep(10000)"), 30);
		await refusal(path, "compatibility-timeout");
	});

	test("returns evidence bound to exact context and declared coverage", async () => {
		const path = await fixture();
		const expected = JSON.stringify({
			projectId: "downstream-project",
			downstreamSha: "c".repeat(40),
			downstreamTree: "d".repeat(40),
			upstream,
		});
		const code = `if (process.env.THINKRAIL_ISSUE_COMPATIBILITY_CONTEXT !== ${JSON.stringify(expected)}) process.exit(4)`;
		await configure(path, bun(code));
		const evidence = await runIssueCompatibility(input(path));
		expect(evidence).toMatchObject({
			kind: "cross-repository",
			downstreamSha: "c".repeat(40),
			downstreamTree: "d".repeat(40),
			upstreamProjectId: upstream.projectId,
			upstreamMergeSha: upstream.mergeCommitSha,
			api: "passed",
			abi: "not-applicable",
			protocol: "passed",
			conflict: "passed",
			checks: "not-applicable",
		});
		expect(evidence.snapshot).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(evidence)).toBe(true);
	});

	test("rejects config changed while command runs", async () => {
		const path = await fixture();
		const configPath = join(path, ".thinkrail", "issue-compatibility.json");
		const replacement = JSON.stringify({
			version: 1,
			command: bun("process.exit(0)"),
			timeoutMs: 2000,
			coverage,
		});
		const code = `await Bun.sleep(100); await Bun.write(${JSON.stringify(configPath)}, ${JSON.stringify(replacement)})`;
		await configure(path, bun(code));
		await refusal(path, "compatibility-config-changed");
	});
});
