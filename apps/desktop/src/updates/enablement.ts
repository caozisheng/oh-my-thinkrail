interface NativeUpdateEnablement {
	isPackaged: boolean;
	channel: string;
	baseUrl: string;
	platform: NodeJS.Platform;
	arch: string;
	artifactTestSeam: boolean;
}

export function nativeUpdatesEnabled(input: NativeUpdateEnablement): boolean {
	if (!input.isPackaged || input.artifactTestSeam) return false;
	if (input.channel !== "stable" && input.channel !== "canary") return false;
	try {
		if (new URL(input.baseUrl).protocol !== "https:") return false;
	} catch {
		return false;
	}
	return ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].includes(
		`${input.platform}-${input.arch}`,
	);
}
