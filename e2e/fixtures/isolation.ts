import { createHash, randomUUID } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import {
	E2E_BINARY_CACHE,
	E2E_DATA_DIR,
	E2E_DESKTOP_CACHE,
	E2E_RESTART_DATA_DIR,
	E2E_RESTART_HOST_LOG,
} from "./paths";

const runToken = process.env.THINKRAIL_E2E_RUN_TOKEN ?? randomUUID();
process.env.THINKRAIL_E2E_RUN_TOKEN = runToken;
const callerHome = homedir();
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(canonical(parent), relative(parent, path));
	}
}

const protectedHomes = [resolve(callerHome), canonical(resolve(callerHome))];
const forbidden = [join(callerHome, ".oh-my-thinkrail"), process.env.THINKRAIL_DATA_DIR]
	.filter((path): path is string => Boolean(path))
	.flatMap((path) => [resolve(path), canonical(resolve(path))]);
const roots = [
	E2E_DATA_DIR,
	E2E_RESTART_DATA_DIR,
	E2E_BINARY_CACHE,
	E2E_DESKTOP_CACHE,
	E2E_RESTART_HOST_LOG,
];

function key(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function contains(parent: string, child: string): boolean {
	const rest = relative(key(parent), key(child));
	return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
}

function fail(): never {
	throw new Error("E2E isolation rejected an unsafe path or host; no reset is permitted");
}

function checkComponents(path: string): void {
	const temp = resolve(tmpdir());
	let current = path;
	while (key(current) !== key(temp)) {
		try {
			if (lstatSync(current).isSymbolicLink()) fail();
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		const parent = dirname(current);
		if (parent === current) fail();
		current = parent;
	}
	let ancestor = path;
	while (true) {
		try {
			const actual = realpathSync(ancestor);
			if (!contains(realpathSync(temp), actual)) fail();
			break;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			ancestor = dirname(ancestor);
		}
	}
}

export function assertE2ePath(path: string): void {
	if (!isAbsolute(path) || key(resolve(path)) !== key(path)) fail();
	if (!contains(resolve(tmpdir()), path) || key(resolve(tmpdir())) === key(path)) fail();
	if (!roots.some((root) => contains(root, path))) fail();
	if (protectedHomes.some((target) => contains(path, target))) fail();
	if (forbidden.some((target) => contains(path, target) || contains(target, path))) fail();
	checkComponents(path);
}

export function assertE2eTree(path = E2E_DATA_DIR): void {
	assertE2ePath(path);
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const child = join(path, entry.name);
		assertE2ePath(child);
		if (entry.isDirectory()) assertE2eTree(child);
	}
}

export function e2eHostEnvironment(dataDir = E2E_DATA_DIR): Record<string, string> {
	assertE2eTree(dataDir);
	return {
		THINKRAIL_DATA_DIR: dataDir,
		...toolHomeEnv(join(dataDir, "home")),
		PI_CODING_AGENT_DIR: join(dataDir, "pi-agent"),
		THINKRAIL_E2E_ISOLATION: runToken,
	};
}

export async function assertNoE2eHost(port: number): Promise<void> {
	try {
		const response = await fetch(`http://localhost:${port}/health`, {
			signal: AbortSignal.timeout(1000),
		});
		await response.body?.cancel();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ConnectionRefused") return;
		if (
			error instanceof TypeError &&
			"cause" in error &&
			error.cause &&
			typeof error.cause === "object" &&
			"code" in error.cause &&
			error.cause.code === "ECONNREFUSED"
		)
			return;
		throw error;
	}
	fail();
}

export async function assertE2eHost(origin: string, dataDir = E2E_DATA_DIR): Promise<void> {
	assertE2eTree(dataDir);
	const expected = createHash("sha256")
		.update(JSON.stringify([runToken, dataDir, join(dataDir, "home"), join(dataDir, "pi-agent")]))
		.digest("hex");
	const response = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(5000) });
	if (!response.ok || response.headers.get("x-thinkrail-e2e-isolation") !== expected) fail();
}
