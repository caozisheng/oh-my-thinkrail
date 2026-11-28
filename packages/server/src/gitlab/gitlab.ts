import type { GitlabAuthStatus } from "@thinkrail/contracts";
import { runBounded } from "../subprocess";

const GLAB_PROBE_TIMEOUT_MS = 8_000;

export async function gitlabAuthStatus(): Promise<GitlabAuthStatus> {
	if (process.env.THINKRAIL_GITLAB_OFFLINE === "1") return { connected: false };
	const result = await runBounded(["glab", "auth", "status"], { timeoutMs: GLAB_PROBE_TIMEOUT_MS });
	if (!result.ok) return { connected: false };
	return parseGlabAuthStatus(`${result.out}\n${result.err}`);
}

export function parseGlabAuthStatus(text: string): GitlabAuthStatus {
	return /Logged in to \S+ as [\w.-]+/i.test(text) ? { connected: true } : { connected: false };
}

export function gitlabRefresh(): Promise<GitlabAuthStatus> {
	return gitlabAuthStatus();
}
