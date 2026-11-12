import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseForkRelease } from "../../apps/desktop/src/forkUpdate/release";
import {
	cliMetadata,
	collectAsset,
	finalizeAssets,
	metadataFromWindowsIdentity,
	parseArches,
	releaseArgs,
	verifyMetadata,
} from "./linux-cli-release";
import { releaseMetadata } from "./windows-release";

const sha = "abcdef0123456789abcdef0123456789abcdef01";
const upstreamSha = "1234567890123456789012345678901234567890";
const latest = { tag_name: "v1.2.3", draft: false, prerelease: false };
const metadata = cliMetadata(releaseMetadata(latest, sha, upstreamSha), ["x64", "arm64"]);

describe("Linux CLI release identity", () => {
	test("shares the Windows version but publishes under its own cli- tag", () => {
		expect(metadata).toMatchObject({
			version: "1.2.3.abcdef01",
			tag: "v1.2.3.abcdef01",
			cliTag: "cli-v1.2.3.abcdef01",
			arches: ["x64", "arm64"],
		});
		expect(parseForkRelease({ tag_name: metadata.cliTag, draft: false, prerelease: false })).toBe(
			null,
		);
	});

	test("accepts only known arch selections", () => {
		expect(parseArches("both")).toEqual(["x64", "arm64"]);
		expect(parseArches("arm64")).toEqual(["arm64"]);
		for (const bad of ["", "x86", "all", "x64,arm64"]) expect(() => parseArches(bad)).toThrow();
	});

	test("derives CLI metadata from the shared Windows release identity", () => {
		const windows = releaseMetadata(latest, sha, upstreamSha);
		expect(metadataFromWindowsIdentity(windows, ["x64"], sha)).toEqual(
			cliMetadata(windows, ["x64"]),
		);
		expect(() => metadataFromWindowsIdentity(windows, ["x64"], upstreamSha)).toThrow(
			"Checkout mismatch",
		);
	});

	test("re-verifies forwarded metadata against the checkout", () => {
		expect(verifyMetadata(JSON.parse(JSON.stringify(metadata)), sha)).toEqual(metadata);
		expect(() => verifyMetadata(metadata, upstreamSha)).toThrow("Checkout mismatch");
		expect(() => verifyMetadata({ ...metadata, cliTag: "v1.2.3.abcdef01" }, sha)).toThrow();
		expect(() => verifyMetadata({ ...metadata, version: "1.2.4.abcdef01" }, sha)).toThrow();
		expect(() => verifyMetadata({ ...metadata, arches: ["x64", "x64"] }, sha)).toThrow();
		expect(() => verifyMetadata({ ...metadata, arches: ["riscv64"] }, sha)).toThrow();
	});

	test("never becomes the repository's latest release", () => {
		const args = releaseArgs(metadata, "owner/repo", ["a"]);
		expect(args.slice(0, 4)).toEqual(["gh", "release", "create", "cli-v1.2.3.abcdef01"]);
		expect(args).toContain("--latest=false");
		expect(args[args.indexOf("--target") + 1]).toBe(sha);
		expect(args.at(-1)).toBe("a");
	});

	test("workflow publishes only after build and only through the verified helper", () => {
		const workflow = readFileSync(
			resolve(import.meta.dir, "../workflows/release-linux-cli.yml"),
			"utf8",
		);
		expect(workflow).toContain("needs: [prepare, build]");
		expect(workflow).toContain("!inputs.dry_run");
		expect(workflow).toContain("bun run smoke:binary");
		expect(workflow).not.toContain("gh release create");
		expect(workflow).toContain("vars.LINUX_CLI_AUTO_RELEASE == 'true'");
		expect(workflow).toContain("github.event_name == 'workflow_dispatch' ||");
		expect(workflow).toContain("github.event_name == 'push' && 'skip' || 'refuse'");
	});
});

describe("Linux CLI release assets", () => {
	test("collects per-arch binaries into installer-compatible SHA256SUMS and provenance", () => {
		const dir = mkdtempSync(join(tmpdir(), "linux-cli-release-"));
		try {
			const sums: string[] = [];
			for (const arch of metadata.arches) {
				const source = join(dir, `source-${arch}`);
				writeFileSync(source, `binary ${arch}`);
				const record = collectAsset(metadata, arch, source, join(dir, "out"));
				const digest = createHash("sha256").update(`binary ${arch}`).digest("hex");
				expect(record).toEqual({ arch, artifact: `thinkrail-linux-${arch}`, sha256: digest });
				sums.push(`${digest}  thinkrail-linux-${arch}\n`);
			}
			const files = finalizeAssets(metadata, join(dir, "out"));
			expect(files.map((file) => file.slice(join(dir, "out").length + 1))).toEqual([
				"thinkrail-linux-x64",
				"thinkrail-linux-arm64",
				"SHA256SUMS",
				"build-info.json",
			]);
			expect(readFileSync(join(dir, "out", "SHA256SUMS"), "utf8")).toBe(sums.join(""));
			const info = JSON.parse(readFileSync(join(dir, "out", "build-info.json"), "utf8"));
			expect(info).toMatchObject({ cliTag: metadata.cliTag, sha, upstreamSha });
			expect(info.artifacts).toHaveLength(2);

			writeFileSync(join(dir, "out", "thinkrail-linux-arm64"), "tampered");
			expect(() => finalizeAssets(metadata, join(dir, "out"))).toThrow("mismatch");
			rmSync(join(dir, "out", "thinkrail-linux-arm64"));
			expect(() => finalizeAssets(metadata, join(dir, "out"))).toThrow("Missing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
