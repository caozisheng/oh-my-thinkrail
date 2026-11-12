import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Ubuntu apt sources bypass Azure and mirror indirection without changing suites or third parties", () => {
	const root = mkdtempSync(join(tmpdir(), "ubuntu-apt-"));
	try {
		mkdirSync(join(root, "sources.list.d"));
		const files = {
			"sources.list": "deb http://azure.archive.ubuntu.com/ubuntu noble main\n",
			"sources.list.d/ubuntu.sources":
				"Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: mirror+file:/etc/apt/apt-security-mirrors.txt\nSuites: noble-security\n",
			"apt-mirrors.txt": "https://azure.archive.ubuntu.com/ubuntu\n",
			"sources.list.d/vendor.list":
				"deb https://packages.microsoft.com/ubuntu/24.04/prod noble main\n",
		};
		for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
		const run = () => {
			const result = Bun.spawnSync(["bash", join(import.meta.dir, "ubuntu-apt-sources.sh"), root]);
			expect(result.exitCode).toBe(0);
		};
		run();
		for (const [file, text] of Object.entries(files)) {
			expect(readFileSync(join(root, file), "utf8")).toBe(
				text
					.replaceAll("mirror+file:/etc/apt/apt-mirrors.txt", "https://archive.ubuntu.com/ubuntu")
					.replaceAll(
						"mirror+file:/etc/apt/apt-security-mirrors.txt",
						"https://security.ubuntu.com/ubuntu",
					)
					.replace(
						/https?:\/\/azure.archive.ubuntu.com\/ubuntu/g,
						"https://archive.ubuntu.com/ubuntu",
					),
			);
		}
		run();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
