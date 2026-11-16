import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { e2eHostEnvironment } from "../../fixtures/isolation";
import { E2E_PI_AGENT_DIR } from "../../fixtures/paths";

const isolatedEnv = e2eHostEnvironment();
Object.assign(process.env, isolatedEnv);
const workerAgentDir = join(E2E_PI_AGENT_DIR, `worker-${process.pid}`);
mkdirSync(workerAgentDir, { recursive: true });
for (const file of ["auth.json", "models.json", "settings.json"]) {
	const src = join(E2E_PI_AGENT_DIR, file);
	if (existsSync(src)) copyFileSync(src, join(workerAgentDir, file));
}

process.env.PI_CODING_AGENT_DIR = workerAgentDir;
