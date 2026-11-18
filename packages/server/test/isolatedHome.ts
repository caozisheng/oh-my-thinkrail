import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";

const root = mkdtempSync(join(tmpdir(), "thinkrail-server-test-home-"));
const home = join(root, "home");
mkdirSync(home);
Object.assign(process.env, toolHomeEnv(home), {
	THINKRAIL_DATA_DIR: join(root, "data"),
	PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
