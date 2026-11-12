import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliMetadata, collectAsset } from "./linux-cli-release";
import {
	collectAssets,
	combinedReleaseArgs,
	finalizeCombinedAssets,
	readReleaseMetadata,
	releaseMetadata,
	stampVersion,
} from "./windows-release";

const sha = "abcdef0123456789abcdef0123456789abcdef01";
const upstreamSha = "1234567890123456789012345678901234567890";
const latest = { tag_name: "v1.2.3", draft: false, prerelease: false };

test("manual release smoke and collection consume the renamed Electrobun ZIP", () => {
	const root = resolve(import.meta.dir, "../..");
	const installer = "apps/desktop/artifacts/win-x64-oh-my-thinkrail-Setup.zip";
	const workflow = readFileSync(
		join(root, ".github/workflows/release-windows-desktop.yml"),
		"utf8",
	);
	const source = readFileSync(join(root, ".github/scripts/windows-release.ts"), "utf8");
	expect(workflow).toContain("name: Release (Windows desktop + Linux CLI)");
	expect(workflow).toContain(`bun run smoke:desktop:installer ${installer} stable`);
	expect(workflow).toContain("needs: [prepare, build, linux]");
	expect(workflow).toContain('bun .github/scripts/linux-cli-release.ts collect "$ARCH"');
	expect(workflow).toContain("thinkrail-linux-");
	expect(workflow).not.toContain("gh release create");
	expect(source.replace(/\s+/g, "")).toContain(
		`collectAssets(metadata,"${installer}","release-assets"`,
	);
	expect(source).toContain("finalizeCombinedAssets");
	expect(source).not.toContain("gh release create");
});

describe("Windows desktop release identity", () => {
	test("uses stable upstream version and exact checkout identity", () => {
		const metadata = releaseMetadata(latest, sha, upstreamSha);
		expect(metadata).toMatchObject({
			version: "1.2.3.abcdef01",
			tag: "v1.2.3.abcdef01",
			sha,
			channel: "stable",
			upstreamTag: "v1.2.3",
			upstreamSha,
		});
		expect(releaseMetadata({ ...latest, tag_name: "1.2.3" }, sha, upstreamSha).version).toBe(
			metadata.version,
		);
	});

	test("rejects non-stable, malformed tags and incomplete commits", () => {
		for (const tag_name of ["v1.2", "v01.2.3", "v1.2.3-rc.1", "v1.2.3+meta", "v1.2.3\n"]) {
			expect(() => releaseMetadata({ ...latest, tag_name }, sha, upstreamSha)).toThrow();
		}
		for (const release of [{ ...latest, draft: true }, { ...latest, prerelease: true }, {}]) {
			expect(() => releaseMetadata(release, sha, upstreamSha)).toThrow();
		}
		for (const badSha of ["abcdef01", "g".repeat(40), `${sha}\n`]) {
			expect(() => releaseMetadata(latest, badSha, upstreamSha)).toThrow();
			expect(() => releaseMetadata(latest, sha, badSha)).toThrow();
		}
	});

	test("stamps full commit, stable channel and disabled analytics", () => {
		expect(stampVersion(releaseMetadata(latest, sha, upstreamSha))).toBe(
			`export const version = "1.2.3.abcdef01";\nexport const channel = "stable";\nexport const commit = "${sha}";\nexport const posthogProjectKey = "";\n`,
		);
	});

	test("collects only versioned installer, checksum and provenance", () => {
		const root = mkdtempSync(join(tmpdir(), "windows-release-test-"));
		try {
			const source = join(root, "installer.zip");
			writeFileSync(source, "fixture installer");
			const metadata = releaseMetadata(latest, sha, upstreamSha);
			const output = join(root, "assets");
			const name = collectAssets(metadata, source, output);
			expect(name).toBe("oh-my-thinkrail-1.2.3.abcdef01-windows-x64.zip");
			expect(readFileSync(join(output, name), "utf8")).toBe("fixture installer");
			const digest = createHash("sha256").update("fixture installer").digest("hex");
			expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toBe(`${digest}  ${name}\n`);
			expect(JSON.parse(readFileSync(join(output, "build-info.json"), "utf8"))).toMatchObject({
				...metadata,
				artifact: name,
				sha256: digest,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Combined Windows + Linux release assets", () => {
	const metadata = releaseMetadata(latest, sha, upstreamSha);

	test("re-verifies forwarded metadata against the checkout", () => {
		expect(readReleaseMetadata(JSON.parse(JSON.stringify(metadata)), sha)).toEqual(metadata);
		expect(() => readReleaseMetadata(metadata, upstreamSha)).toThrow("Checkout mismatch");
		expect(() => readReleaseMetadata({ ...metadata, version: "1.2.4.abcdef01" }, sha)).toThrow();
	});

	test("merges Linux CLI binaries into one Latest release without dropping Windows identity", () => {
		const root = mkdtempSync(join(tmpdir(), "combined-release-"));
		try {
			const output = join(root, "assets");
			writeFileSync(join(root, "installer.zip"), "fixture installer");
			const windowsName = collectAssets(metadata, join(root, "installer.zip"), output);
			const windowsDigest = createHash("sha256").update("fixture installer").digest("hex");
			const linuxMeta = cliMetadata(metadata, ["x64", "arm64"]);
			const linuxSums: string[] = [];
			for (const arch of linuxMeta.arches) {
				const source = join(root, `cli-${arch}`);
				writeFileSync(source, `binary ${arch}`);
				collectAsset(linuxMeta, arch, source, output);
				linuxSums.push(
					`${createHash("sha256").update(`binary ${arch}`).digest("hex")}  thinkrail-linux-${arch}\n`,
				);
			}
			const files = finalizeCombinedAssets(metadata, output);
			expect(files.map((file) => file.slice(output.length + 1))).toEqual([
				windowsName,
				"thinkrail-linux-x64",
				"thinkrail-linux-arm64",
				"SHA256SUMS",
				"build-info.json",
			]);
			expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toBe(
				`${windowsDigest}  ${windowsName}\n${linuxSums.join("")}`,
			);
			expect(JSON.parse(readFileSync(join(output, "build-info.json"), "utf8"))).toMatchObject({
				...metadata,
				artifact: windowsName,
				sha256: windowsDigest,
				artifacts: [
					{ artifact: windowsName, sha256: windowsDigest },
					{
						artifact: "thinkrail-linux-x64",
						sha256: createHash("sha256").update("binary x64").digest("hex"),
					},
					{
						artifact: "thinkrail-linux-arm64",
						sha256: createHash("sha256").update("binary arm64").digest("hex"),
					},
				],
			});
			const args = combinedReleaseArgs(metadata, "owner/repo", files);
			expect(args.slice(0, 4)).toEqual(["gh", "release", "create", "v1.2.3.abcdef01"]);
			expect(args).toContain("--title");
			expect(args[args.indexOf("--title") + 1]).toBe(
				"oh-my-thinkrail 1.2.3.abcdef01 (Windows x64 + Linux x64/arm64)",
			);
			expect(args).not.toContain("--latest=false");
			expect(args[args.indexOf("--target") + 1]).toBe(sha);
			expect(args).toContain(join(output, "thinkrail-linux-x64"));
			expect(args).toContain(join(output, "thinkrail-linux-arm64"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses to publish when a Linux CLI asset is missing or tampered", () => {
		const root = mkdtempSync(join(tmpdir(), "combined-release-missing-"));
		try {
			const output = join(root, "assets");
			writeFileSync(join(root, "installer.zip"), "fixture installer");
			collectAssets(metadata, join(root, "installer.zip"), output);
			expect(() => finalizeCombinedAssets(metadata, output)).toThrow("Missing release asset");
			const linuxMeta = cliMetadata(metadata, ["x64", "arm64"]);
			for (const arch of linuxMeta.arches) {
				const source = join(root, `cli-${arch}`);
				writeFileSync(source, `binary ${arch}`);
				collectAsset(linuxMeta, arch, source, output);
			}
			writeFileSync(join(output, "thinkrail-linux-arm64"), "tampered");
			expect(() => finalizeCombinedAssets(metadata, output)).toThrow("mismatch");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
