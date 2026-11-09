export const FORK_REPOSITORY = "caozisheng/oh-my-thinkrail";

export const FORK_RELEASES_API = `https://api.github.com/repos/${FORK_REPOSITORY}/releases/latest`;

const FORK_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.([0-9a-f]{8})$/;
const CURRENT_VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.([0-9a-f]{8}))?$/;

export interface ForkRelease {
	/** `X.Y.Z.<fork sha8>` — the tag without its `v`. */
	version: string;
	/** The validated tag published by the fork's release workflow. */
	tag: string;
}

interface ParsedVersion {
	base: readonly [number, number, number];
	sha: string | null;
}

function parseVersion(value: string, pattern: RegExp): ParsedVersion | null {
	const match = pattern.exec(value);
	if (!match?.[1] || !match[2] || !match[3]) return null;
	return {
		base: [Number(match[1]), Number(match[2]), Number(match[3])],
		sha: match[4] ?? null,
	};
}

function compareBase(left: ParsedVersion, right: ParsedVersion): number {
	for (let index = 0; index < 3; index += 1) {
		const difference = (left.base[index] ?? 0) - (right.base[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The release page for a validated tag; the fork never trusts a remote response's own URL. */
export function forkReleaseUrl(tag: string): string {
	return `https://github.com/${FORK_REPOSITORY}/releases/tag/${tag}`;
}

export function parseForkRelease(raw: unknown): ForkRelease | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const draft: unknown = Reflect.get(raw, "draft");
	const prerelease: unknown = Reflect.get(raw, "prerelease");
	const tagName: unknown = Reflect.get(raw, "tag_name");
	if (draft === true || prerelease === true || typeof tagName !== "string") return null;
	const version = tagName.replace(/^v/, "");
	return FORK_VERSION_PATTERN.test(version) ? { version, tag: `v${version}` } : null;
}

/**
 * `newer` when the release should be offered, `same`/`older`/`unknown` when it must not be.
 * A larger base always wins; an equal base counts only when its fork sha differs, which is a
 * re-published rebuild of the same upstream version. Downgrades are never offered.
 */
export function compareForkVersion(
	currentVersion: string,
	candidate: ForkRelease,
): "newer" | "same" | "older" | "unknown" {
	const current = parseVersion(currentVersion, CURRENT_VERSION_PATTERN);
	const next = parseVersion(candidate.version, FORK_VERSION_PATTERN);
	if (!current || !next) return "unknown";
	const base = compareBase(next, current);
	if (base > 0) return "newer";
	if (base < 0) return "older";
	return current.sha !== null && current.sha === next.sha ? "same" : "newer";
}
