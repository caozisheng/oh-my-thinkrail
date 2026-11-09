import { FORK_RELEASES_API, type ForkRelease, parseForkRelease } from "./release";

const REQUEST_TIMEOUT_MS = 5000;

export type ForkReleaseFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One bounded, unauthenticated GitHub API read; any failure is simply "no answer". */
export async function fetchLatestForkRelease(
	fetchImpl: ForkReleaseFetch = (url, init) => fetch(url, init),
): Promise<ForkRelease | null> {
	const response = await fetchImpl(FORK_RELEASES_API, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: { accept: "application/vnd.github+json" },
	});
	if (!response.ok) return null;
	return parseForkRelease(await response.json());
}
