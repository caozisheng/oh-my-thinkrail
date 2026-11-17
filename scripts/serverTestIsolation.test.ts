import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const persistence = pathToFileURL(
	join(root, "packages/server/src/persistence/persistence.ts"),
).href;

for (const cwd of [root, join(root, "packages/server")]) {
	for (const inheritedData of [false, true]) {
		test(`server tests isolate registries from ${relative(root, cwd) || "root"}, inherited data ${inheritedData}`, async () => {
			const fake = mkdtempSync(join(tmpdir(), "thinkrail-unit-sentinel-"));
			const fixtureRoot = mkdtempSync(join(cwd, ".test-isolation-"));
			const fixture = join(fixtureRoot, "registry.test.ts");
			const output = join(fake, "effective.json");
			const projects = join(fake, "projects.json");
			const workspaces = join(fake, "workspaces.json");
			const sentinel = "[]\n";
			writeFileSync(projects, sentinel);
			writeFileSync(workspaces, sentinel);
			writeFileSync(
				fixture,
				`
import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dataDir, saveProjects, saveWorkspaces } from ${JSON.stringify(persistence)};
test("writes registry fixtures", () => {
	writeFileSync(${JSON.stringify(output)}, JSON.stringify({ data: dataDir(), home: homedir(), userprofile: process.env.USERPROFILE, agent: process.env.PI_CODING_AGENT_DIR }));
	saveProjects([{ id: "fixture", name: "fixture", slug: "fixture", path: ${JSON.stringify(fake)}, lastOpened: 1 }]);
	saveWorkspaces([]);
});
`,
			);
			const env: NodeJS.ProcessEnv = { ...process.env, HOME: fake, USERPROFILE: fake };
			if (inheritedData) env.THINKRAIL_DATA_DIR = fake;
			else delete env.THINKRAIL_DATA_DIR;
			try {
				const child = Bun.spawn([process.execPath, "test", fixture], {
					cwd,
					env,
					stdout: "pipe",
					stderr: "pipe",
				});
				const stderr = await new Response(child.stderr).text();
				expect({ exit: await child.exited, stderr: stderr.includes("1 pass") }).toEqual({
					exit: 0,
					stderr: true,
				});
				expect(readFileSync(projects, "utf8")).toBe(sentinel);
				expect(readFileSync(workspaces, "utf8")).toBe(sentinel);
				const effective: { data: string; home: string; userprofile?: string; agent?: string } =
					JSON.parse(readFileSync(output, "utf8"));
				expect(effective.home).not.toBe(fake);
				expect(effective.userprofile).toBe(effective.home);
				expect(effective.data).not.toBe(resolve(fake));
				expect(effective.data.startsWith(resolve(tmpdir()) + sep)).toBe(true);
				expect(isAbsolute(effective.data)).toBe(true);
				expect(effective.agent).toBe(join(effective.home, ".pi", "agent"));
			} finally {
				rmSync(fake, { recursive: true, force: true });
				rmSync(fixtureRoot, { recursive: true, force: true });
			}
		}, 20_000);
	}
}
