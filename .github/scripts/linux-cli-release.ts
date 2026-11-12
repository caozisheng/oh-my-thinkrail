import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	api,
	assertAbsent,
	releaseMetadata,
	repository,
	run,
	stampVersion,
	upstreamRepository,
} from "./windows-release";

export const linuxArches = ["x64", "arm64"] as const;
export type LinuxArch = (typeof linuxArches)[number];

type Metadata = ReturnType<typeof releaseMetadata>;

export type CliMetadata = Metadata & { cliTag: string; arches: LinuxArch[] };

export function parseArches(selection: string): LinuxArch[] {
	if (selection === "both") return [...linuxArches];
	if ((linuxArches as readonly string[]).includes(selection)) return [selection as LinuxArch];
	throw new Error(`Unsupported arch selection: ${selection} (expected x64, arm64 or both)`);
}

export function cliMetadata(metadata: Metadata, arches: LinuxArch[]): CliMetadata {
	if (arches.length === 0) throw new Error("At least one Linux arch is required");
	return { ...metadata, cliTag: `cli-${metadata.tag}`, arches };
}

export function assetName(arch: LinuxArch): string {
	return `thinkrail-linux-${arch}`;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyMetadata(raw: unknown, headSha: string): CliMetadata {
	const info = raw as Partial<CliMetadata>;
	const arches = (Array.isArray(info.arches) ? info.arches : []).map(
		(arch) => parseArches(String(arch))[0] as LinuxArch,
	);
	if (new Set(arches).size !== arches.length) throw new Error("Duplicate Linux arch");
	const metadata = cliMetadata(
		releaseMetadata(
			{ tag_name: info.upstreamTag, draft: false, prerelease: false },
			String(info.sha),
			String(info.upstreamSha),
		),
		arches,
	);
	if (
		info.version !== metadata.version ||
		info.tag !== metadata.tag ||
		info.cliTag !== metadata.cliTag ||
		JSON.stringify(info.arches) !== JSON.stringify(metadata.arches)
	)
		throw new Error("Release metadata identity mismatch");
	if (metadata.sha !== headSha) throw new Error("Checkout mismatch");
	return metadata;
}

export function metadataFromWindowsIdentity(
	raw: unknown,
	arches: LinuxArch[],
	headSha: string,
): CliMetadata {
	const info = raw as { upstreamTag?: unknown; sha?: unknown; upstreamSha?: unknown };
	return verifyMetadata(
		cliMetadata(
			releaseMetadata(
				{ tag_name: info.upstreamTag, draft: false, prerelease: false },
				String(info.sha),
				String(info.upstreamSha),
			),
			arches,
		),
		headSha,
	);
}

export function collectAsset(
	metadata: CliMetadata,
	arch: LinuxArch,
	source: string,
	output: string,
) {
	const name = assetName(arch);
	mkdirSync(output, { recursive: true });
	copyFileSync(source, join(output, name));
	const record = { arch, artifact: name, sha256: sha256(join(output, name)) };
	writeFileSync(join(output, `${name}.json`), `${JSON.stringify({ ...metadata, ...record })}\n`);
	return record;
}

export function finalizeAssets(metadata: CliMetadata, dir: string): string[] {
	const artifacts = metadata.arches.map((arch) => {
		const name = assetName(arch);
		const path = join(dir, name);
		if (!existsSync(path)) throw new Error(`Missing release asset ${name}`);
		const record = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
		const digest = sha256(path);
		if (
			record.sha256 !== digest ||
			record.sha !== metadata.sha ||
			record.version !== metadata.version
		)
			throw new Error(`Release asset identity/checksum mismatch: ${name}`);
		return { arch, artifact: name, sha256: digest };
	});
	writeFileSync(
		join(dir, "SHA256SUMS"),
		artifacts.map(({ artifact, sha256 }) => `${sha256}  ${artifact}\n`).join(""),
	);
	writeFileSync(
		join(dir, "build-info.json"),
		`${JSON.stringify({ ...metadata, artifacts }, null, 2)}\n`,
	);
	return [
		...artifacts.map(({ artifact }) => join(dir, artifact)),
		join(dir, "SHA256SUMS"),
		join(dir, "build-info.json"),
	];
}

export function releaseArgs(metadata: CliMetadata, repository: string, files: string[]): string[] {
	const arches = metadata.arches.join(" + ");
	return [
		"gh",
		"release",
		"create",
		metadata.cliTag,
		"--repo",
		repository,
		"--target",
		metadata.sha,
		"--title",
		`oh-my-thinkrail ${metadata.version} (Linux CLI ${arches})`,
		"--latest=false",
		"--notes",
		`Independent oh-my-thinkrail fork. Unsigned single-file Linux CLI (${arches}); not a JetBrains distribution. Download thinkrail-linux-<arch>, verify it against SHA256SUMS, install it as ~/.local/bin/thinkrail and run \`thinkrail --no-open\`; for a remote machine, keep the default localhost bind and reach it through \`ssh -L 24242:127.0.0.1:24242\`. Do not run \`thinkrail update\`: it reinstalls upstream JetBrains ThinkRail over this fork build. Published with latest=false so the Windows desktop fork-update advisory keeps tracking Windows releases. Upstream ${metadata.upstreamTag} (${metadata.upstreamSha}); fork commit ${metadata.sha}.`,
		...files,
	];
}

function releaseExists(repository: string, tag: string): boolean {
	try {
		assertAbsent(repository, tag);
		return false;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Refusing existing")) return true;
		throw error;
	}
}

const metadataFile = "linux-cli-release.json";
const headSha = () => run(["git", "rev-parse", "HEAD"]);
const readMetadata = (path: string) =>
	verifyMetadata(JSON.parse(readFileSync(path, "utf8")), headSha());

if (import.meta.main) {
	const command = process.argv[2];
	if (command === "prepare") {
		const latest = api(`repos/${upstreamRepository}/releases/latest`) as { tag_name: string };
		const upstream = api(
			`repos/${upstreamRepository}/commits/${encodeURIComponent(latest.tag_name)}`,
		) as { sha: string };
		const metadata = cliMetadata(
			releaseMetadata(latest, headSha(), upstream.sha),
			parseArches(process.argv[4] ?? "both"),
		);
		if (releaseExists(repository(), metadata.cliTag)) {
			if (process.argv[5] !== "skip")
				throw new Error(`Refusing existing release or tag: ${metadata.cliTag}`);
			console.log(`::notice::${metadata.cliTag} already exists; auto release skipped`);
		} else {
			writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
		}
	} else if (command === "stamp") {
		writeFileSync("packages/shared/src/version.ts", stampVersion(readMetadata(metadataFile)));
	} else if (command === "collect") {
		const arch = parseArches(process.argv[3] ?? "")[0] as LinuxArch;
		const metadata = existsSync(metadataFile)
			? readMetadata(metadataFile)
			: metadataFromWindowsIdentity(
					JSON.parse(readFileSync(".windows-release.json", "utf8")),
					[arch],
					headSha(),
				);
		collectAsset(metadata, arch, `apps/cli/dist/${assetName(arch)}`, "release-assets");
	} else if (command === "publish") {
		const metadata = readMetadata(metadataFile);
		const files = finalizeAssets(metadata, "release-assets");
		assertAbsent(repository(), metadata.cliTag);
		console.log(run(releaseArgs(metadata, repository(), files)));
	} else {
		throw new Error("Expected prepare, stamp, collect or publish");
	}
}
