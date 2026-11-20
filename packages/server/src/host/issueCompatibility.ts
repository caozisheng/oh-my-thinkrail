import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { CodedError } from "@thinkrail/shared/codedError";
import type {
	IssueCompatibilityEvidence,
	IssueDependencyMerge,
} from "./issueRepositoryDependencies";

const MAX_CONFIG_BYTES = 64 * 1024;
const dimensions = ["api", "abi", "protocol", "conflict", "checks"] as const;
type Coverage = Record<(typeof dimensions)[number], "checked" | "not-applicable">;
interface CompatibilityConfig {
	version: 1;
	command: string[];
	timeoutMs: number;
	coverage: Coverage;
}

function refuse(reason: "missing" | "invalid" | "failed" | "timeout" | "config-changed"): never {
	throw new CodedError(
		"ISSUE_DELIVERY_REFUSED",
		`Repository compatibility refused (compatibility-${reason}). Configure or repair the trusted project's compatibility runner and prepare again.`,
	);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function parseConfig(bytes: Buffer): CompatibilityConfig {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		refuse("invalid");
	}
	if (
		!exactKeys(value, ["version", "command", "timeoutMs", "coverage"]) ||
		value.version !== 1 ||
		!Array.isArray(value.command) ||
		value.command.length < 1 ||
		value.command.length > 128 ||
		!value.command.every(
			(arg) => typeof arg === "string" && arg.length <= 8192 && !arg.includes("\0"),
		) ||
		!value.command[0] ||
		typeof value.timeoutMs !== "number" ||
		!Number.isSafeInteger(value.timeoutMs) ||
		value.timeoutMs < 1 ||
		value.timeoutMs > 300_000 ||
		!exactKeys(value.coverage, dimensions)
	)
		refuse("invalid");
	const coverage = value.coverage;
	if (
		!dimensions.every((key) => coverage[key] === "checked" || coverage[key] === "not-applicable") ||
		!dimensions.some((key) => coverage[key] === "checked")
	)
		refuse("invalid");
	return value as unknown as CompatibilityConfig;
}

async function readConfig(path: string): Promise<Buffer> {
	try {
		const directory = join(path, ".thinkrail");
		const directoryStat = await lstat(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) refuse("invalid");
		const filename = join(directory, "issue-compatibility.json");
		const before = await lstat(filename);
		if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONFIG_BYTES)
			refuse("invalid");
		const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) refuse("invalid");
			const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await file.read(bytes, length, bytes.length - length, null);
				if (read.bytesRead === 0) break;
				length += read.bytesRead;
			}
			const after = await lstat(filename);
			const directoryAfter = await lstat(directory);
			if (
				length > MAX_CONFIG_BYTES ||
				after.isSymbolicLink() ||
				after.dev !== stat.dev ||
				after.ino !== stat.ino ||
				directoryAfter.isSymbolicLink() ||
				directoryAfter.dev !== directoryStat.dev ||
				directoryAfter.ino !== directoryStat.ino
			)
				refuse("invalid");
			return bytes.subarray(0, length);
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof CodedError) throw error;
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
			refuse("missing");
		refuse("invalid");
	}
}

export async function runIssueCompatibility(input: {
	path: string;
	projectId: string;
	downstreamSha: string;
	downstreamTree: string;
	upstream: IssueDependencyMerge;
}): Promise<IssueCompatibilityEvidence> {
	const context = JSON.stringify({
		projectId: input.projectId,
		downstreamSha: input.downstreamSha,
		downstreamTree: input.downstreamTree,
		upstream: { ...input.upstream },
	});
	const binding = JSON.parse(context) as Omit<typeof input, "path">;
	const bytes = await readConfig(input.path);
	const config = parseConfig(bytes);
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let exitCode: number;
	try {
		const process = Bun.spawn(config.command, {
			cwd: input.path,
			env: { ...Bun.env, THINKRAIL_ISSUE_COMPATIBILITY_CONTEXT: context },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		timer = setTimeout(() => {
			timedOut = true;
			process.kill("SIGKILL");
		}, config.timeoutMs);
		exitCode = await process.exited;
	} catch {
		refuse(timedOut ? "timeout" : "failed");
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) refuse("timeout");
	if (exitCode !== 0) refuse("failed");
	let after: Buffer;
	try {
		after = await readConfig(input.path);
	} catch {
		refuse("config-changed");
	}
	if (!bytes.equals(after)) refuse("config-changed");
	const status = (key: (typeof dimensions)[number]) =>
		config.coverage[key] === "checked" ? "passed" : "not-applicable";
	return Object.freeze({
		kind: "cross-repository",
		downstreamSha: binding.downstreamSha,
		downstreamTree: binding.downstreamTree,
		upstreamProjectId: binding.upstream.projectId,
		upstreamMergeSha: binding.upstream.mergeCommitSha,
		api: status("api"),
		abi: status("abi"),
		protocol: status("protocol"),
		conflict: status("conflict"),
		checks: status("checks"),
		snapshot: createHash("sha256").update(bytes).update("\0").update(context).digest("hex"),
	});
}
