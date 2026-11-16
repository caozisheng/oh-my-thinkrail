import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertE2eHost,
	assertE2ePath,
	assertE2eTree,
	assertNoE2eHost,
	e2eHostEnvironment,
} from "../e2e/fixtures/isolation";
import { E2E_DATA_DIR } from "../e2e/fixtures/paths";

test("unsafe cleanup targets are rejected", () => {
	for (const path of [
		tmpdir(),
		process.cwd(),
		`${E2E_DATA_DIR}-neighbor`,
		join(E2E_DATA_DIR, ".."),
		"relative",
		`${E2E_DATA_DIR}/../escape`,
	]) {
		expect(() => assertE2ePath(path)).toThrow("E2E isolation");
	}
	expect(() => assertE2ePath(join(E2E_DATA_DIR, "safe-missing", "projects.json"))).not.toThrow();
});

test("junction redirection fails before deleting a fake production sentinel", () => {
	const fake = mkdtempSync(join(tmpdir(), "thinkrail-isolation-sentinel-"));
	const link = join(E2E_DATA_DIR, `isolation-link-${process.pid}`);
	mkdirSync(E2E_DATA_DIR, { recursive: true });
	writeFileSync(join(fake, "projects.json"), "do not touch");
	try {
		symlinkSync(fake, link, process.platform === "win32" ? "junction" : "dir");
		expect(() => assertE2eTree()).toThrow("E2E isolation");
		expect(() => assertE2ePath(join(link, "projects.json"))).toThrow("E2E isolation");
		expect(readFileSync(join(fake, "projects.json"), "utf8")).toBe("do not touch");
	} finally {
		rmSync(link, { recursive: true, force: true });
		rmSync(fake, { recursive: true, force: true });
	}
});

test("caller data aliases into a lane block teardown and preserve registry bytes", async () => {
	const fake = mkdtempSync(join(tmpdir(), "thinkrail-isolation-alias-"));
	const alias = join(fake, "production-data");
	const sentinel = join(E2E_DATA_DIR, `protected-${process.pid}.json`);
	mkdirSync(E2E_DATA_DIR, { recursive: true });
	writeFileSync(sentinel, "protected registry");
	try {
		symlinkSync(E2E_DATA_DIR, alias, process.platform === "win32" ? "junction" : "dir");
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
			const { default: teardown } = await import("./e2e/global-teardown.ts");
			try { teardown(); process.exit(2); } catch (error) {
				if (!error.message.includes("E2E isolation")) throw error;
			}
		`,
			],
			{ env: { ...process.env, THINKRAIL_DATA_DIR: alias }, stdout: "pipe", stderr: "pipe" },
		);
		expect(await child.exited).toBe(0);
		expect(readFileSync(sentinel, "utf8")).toBe("protected registry");
	} finally {
		rmSync(alias, { recursive: true, force: true });
		rmSync(fake, { recursive: true, force: true });
		rmSync(sentinel, { force: true });
	}
});

test("an ordinary healthy host grants no reset authority", async () => {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	try {
		await expect(assertE2eHost(`http://localhost:${server.port}`)).rejects.toThrow("E2E isolation");
	} finally {
		server.stop(true);
	}
});

test("prelaunch rejects an occupied endpoint", async () => {
	const server = Bun.serve({ port: 0, fetch: () => new Response("stale host") });
	const port = Number(server.port);
	try {
		await expect(assertNoE2eHost(port)).rejects.toThrow("E2E isolation");
	} finally {
		server.stop(true);
	}
	await assertNoE2eHost(port);
});

test("host environment overrides both homes, data and tool paths", () => {
	const env = {
		THINKRAIL_DATA_DIR: "/production",
		HOME: "/production",
		USERPROFILE: "/production",
		CODEX_HOME: "/production",
		...e2eHostEnvironment(),
	};
	expect(env.THINKRAIL_DATA_DIR).toBe(E2E_DATA_DIR);
	expect(env.HOME).toBe(join(E2E_DATA_DIR, "home"));
	expect(env.USERPROFILE).toBe(env.HOME);
	expect(env.CODEX_HOME).toBe(join(env.HOME, ".codex"));
});

test("workflow workers override inherited production data before loading persistence", async () => {
	const fake = mkdtempSync(join(tmpdir(), "thinkrail-isolation-test-"));
	const sentinel = join(fake, "projects.json");
	writeFileSync(sentinel, "production sentinel\n");
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
			await import("./e2e/workflows/harness/env.ts");
			const { dataDir } = await import("./packages/server/src/persistence/persistence.ts");
			const { E2E_DATA_DIR } = await import("./e2e/fixtures/paths.ts");
			if (dataDir() !== E2E_DATA_DIR) throw new Error("workflow persistence escaped isolation");
		`,
			],
			{
				env: { ...process.env, THINKRAIL_DATA_DIR: fake, HOME: fake, USERPROFILE: fake },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = await new Response(child.stderr).text();
		expect({ exit: await child.exited, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(readFileSync(sentinel, "utf8")).toBe("production sentinel\n");
	} finally {
		rmSync(fake, { recursive: true, force: true });
	}
});
