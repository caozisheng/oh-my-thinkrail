import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const upstreamRepository = "JetBrains/thinkrail";
const fullSha = /^[0-9a-fA-F]{40}$/;
const stableTag = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

type Metadata = {
	version: string;
	tag: string;
	sha: string;
	channel: "stable";
	upstreamRepository: string;
	upstreamTag: string;
	upstreamSha: string;
};

export function releaseMetadata(latest: unknown, sha: string, upstreamSha: string): Metadata {
	const release = latest as { tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null;
	if (
		release?.draft !== false ||
		release.prerelease !== false ||
		typeof release.tag_name !== "string" ||
		!stableTag.test(release.tag_name) ||
		/\s/.test(release.tag_name)
	) {
		throw new Error("Upstream latest release must have a strict stable X.Y.Z tag (optional v)");
	}
	if (
		sha.length !== 40 ||
		upstreamSha.length !== 40 ||
		!fullSha.test(sha) ||
		!fullSha.test(upstreamSha)
	) {
		throw new Error("Release commits must be full 40-digit hexadecimal SHAs");
	}
	const version = `${release.tag_name.replace(/^v/, "")}.${sha.slice(0, 8)}`;
	return {
		version,
		tag: `v${version}`,
		sha,
		channel: "stable",
		upstreamRepository,
		upstreamTag: release.tag_name,
		upstreamSha,
	};
}

export function stampVersion(metadata: Metadata): string {
	return `export const version = "${metadata.version}";\nexport const channel = "stable";\nexport const commit = "${metadata.sha}";\nexport const posthogProjectKey = "";\n`;
}

export function collectAssets(metadata: Metadata, source: string, output: string): string {
	const name = `oh-my-thinkrail-${metadata.version}-windows-x64.zip`;
	mkdirSync(output, { recursive: true });
	copyFileSync(source, join(output, name));
	const sha256 = createHash("sha256")
		.update(readFileSync(join(output, name)))
		.digest("hex");
	writeFileSync(join(output, "SHA256SUMS"), `${sha256}  ${name}\n`);
	writeFileSync(
		join(output, "build-info.json"),
		`${JSON.stringify({ ...metadata, artifact: name, sha256 }, null, 2)}\n`,
	);
	return name;
}

export const linuxCliAssetNames = ["thinkrail-linux-x64", "thinkrail-linux-arm64"] as const;

export function windowsInstallerName(metadata: Metadata): string {
	return `oh-my-thinkrail-${metadata.version}-windows-x64.zip`;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readReleaseMetadata(raw: unknown, headSha: string): Metadata {
	const info = raw as Partial<Metadata>;
	const metadata = releaseMetadata(
		{ tag_name: info.upstreamTag, draft: false, prerelease: false },
		String(info.sha),
		String(info.upstreamSha),
	);
	if (
		info.version !== metadata.version ||
		info.tag !== metadata.tag ||
		info.sha !== metadata.sha ||
		info.channel !== metadata.channel ||
		info.upstreamRepository !== metadata.upstreamRepository ||
		info.upstreamTag !== metadata.upstreamTag ||
		info.upstreamSha !== metadata.upstreamSha
	) {
		throw new Error("Release metadata identity mismatch");
	}
	if (metadata.sha !== headSha) throw new Error("Checkout mismatch");
	return metadata;
}

export function verifyWindowsCollectedAssets(
	metadata: Metadata,
	dir: string,
): { artifact: string; sha256: string } {
	const artifact = windowsInstallerName(metadata);
	const digest = sha256File(join(dir, artifact));
	const info = JSON.parse(
		readFileSync(join(dir, "build-info.json"), "utf8"),
	) as Partial<Metadata> & {
		artifact?: unknown;
		sha256?: unknown;
	};
	if (
		info.tag !== metadata.tag ||
		info.version !== metadata.version ||
		info.sha !== metadata.sha ||
		info.artifact !== artifact ||
		info.sha256 !== digest ||
		readFileSync(join(dir, "SHA256SUMS"), "utf8") !== `${digest}  ${artifact}\n`
	) {
		throw new Error("Release asset identity/checksum mismatch");
	}
	return { artifact, sha256: digest };
}

export function finalizeCombinedAssets(metadata: Metadata, dir: string): string[] {
	const windows = verifyWindowsCollectedAssets(metadata, dir);
	const linux = linuxCliAssetNames.map((artifact) => {
		const path = join(dir, artifact);
		if (!existsSync(path)) throw new Error(`Missing release asset ${artifact}`);
		const sidecarPath = join(dir, `${artifact}.json`);
		if (!existsSync(sidecarPath)) throw new Error(`Missing release provenance ${artifact}.json`);
		const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
			sha256?: unknown;
			sha?: unknown;
			version?: unknown;
			artifact?: unknown;
		};
		const digest = sha256File(path);
		if (
			sidecar.sha256 !== digest ||
			sidecar.sha !== metadata.sha ||
			sidecar.version !== metadata.version ||
			sidecar.artifact !== artifact
		) {
			throw new Error(`Release asset identity/checksum mismatch: ${artifact}`);
		}
		return { artifact, sha256: digest };
	});
	const records = [windows, ...linux];
	writeFileSync(
		join(dir, "SHA256SUMS"),
		records.map(({ artifact, sha256 }) => `${sha256}  ${artifact}\n`).join(""),
	);
	writeFileSync(
		join(dir, "build-info.json"),
		`${JSON.stringify({ ...metadata, artifact: windows.artifact, sha256: windows.sha256, artifacts: records }, null, 2)}\n`,
	);
	return [
		join(dir, windows.artifact),
		...linux.map(({ artifact }) => join(dir, artifact)),
		join(dir, "SHA256SUMS"),
		join(dir, "build-info.json"),
	];
}

export function releaseNotes(metadata: Metadata): string {
	return [
		"Independent oh-my-thinkrail fork. Unsigned Windows x64 desktop installer; Windows SmartScreen may warn.",
		"Extract the ZIP and keep the setup EXE beside its payload before running setup.",
		"Also includes unsigned Linux CLI binaries thinkrail-linux-x64 and thinkrail-linux-arm64;",
		"verify them against SHA256SUMS, install as ~/.local/bin/thinkrail and run `thinkrail --no-open`;",
		"for a remote machine, keep the default localhost bind and reach it through `ssh -L 24242:127.0.0.1:24242`.",
		"Automatic desktop updates are disabled. Packaged builds check this repository's latest Release at launch",
		"and link here from Settings → Software updates; install subsequent releases manually.",
		"Do not run `thinkrail update`: it reinstalls upstream JetBrains ThinkRail over this fork build.",
		`Upstream ${metadata.upstreamTag} (${metadata.upstreamSha}); fork commit ${metadata.sha}.`,
	].join(" ");
}

export function combinedReleaseArgs(
	metadata: Metadata,
	repository: string,
	files: string[],
): string[] {
	return [
		"gh",
		"release",
		"create",
		metadata.tag,
		"--repo",
		repository,
		"--target",
		metadata.sha,
		"--title",
		`oh-my-thinkrail ${metadata.version} (Windows x64 + Linux x64/arm64)`,
		"--notes",
		releaseNotes(metadata),
		...files,
	];
}

export function run(command: string[]): string {
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	if (!result.success) throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

export function api(endpoint: string): unknown {
	return JSON.parse(run(["gh", "api", endpoint]));
}

export function assertAbsent(repository: string, tag: string): void {
	for (const endpoint of [`releases/tags/${tag}`, `git/ref/tags/${tag}`]) {
		const result = Bun.spawnSync(["gh", "api", `repos/${repository}/${endpoint}`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.success) throw new Error(`Refusing existing release or tag: ${tag}`);
		if (!result.stderr.toString().includes("(HTTP 404)")) {
			throw new Error(`Cannot check release/tag absence: ${result.stderr.toString()}`);
		}
	}
}

export function repository(): string {
	const value = process.argv[3];
	if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error("GITHUB_REPOSITORY required");
	return value;
}

if (import.meta.main) {
	const command = process.argv[2];
	if (command === "prepare") {
		const latest = api(`repos/${upstreamRepository}/releases/latest`) as { tag_name: string };
		const upstream = api(
			`repos/${upstreamRepository}/commits/${encodeURIComponent(latest.tag_name)}`,
		) as { sha: string };
		const metadata = releaseMetadata(latest, run(["git", "rev-parse", "HEAD"]), upstream.sha);
		assertAbsent(repository(), metadata.tag);
		writeFileSync(".windows-release.json", `${JSON.stringify(metadata, null, 2)}\n`);
		writeFileSync("packages/shared/src/version.ts", stampVersion(metadata));
	} else if (command === "stamp") {
		const metadata = readReleaseMetadata(
			JSON.parse(readFileSync(".windows-release.json", "utf8")),
			run(["git", "rev-parse", "HEAD"]),
		);
		writeFileSync("packages/shared/src/version.ts", stampVersion(metadata));
	} else if (command === "collect") {
		const metadata = readReleaseMetadata(
			JSON.parse(readFileSync(".windows-release.json", "utf8")),
			run(["git", "rev-parse", "HEAD"]),
		);
		collectAssets(
			metadata,
			"apps/desktop/artifacts/win-x64-oh-my-thinkrail-Setup.zip",
			"release-assets",
		);
	} else if (command === "publish") {
		const metadata = readReleaseMetadata(
			JSON.parse(readFileSync("release-assets/build-info.json", "utf8")),
			run(["git", "rev-parse", "HEAD"]),
		);
		const files = finalizeCombinedAssets(metadata, "release-assets");
		assertAbsent(repository(), metadata.tag);
		console.log(run(combinedReleaseArgs(metadata, repository(), files)));
	} else {
		throw new Error("Expected prepare, stamp, collect or publish");
	}
}
