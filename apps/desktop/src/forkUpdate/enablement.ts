interface ForkUpdateEnablement {
	isPackaged: boolean;
	channel: string;
	platform: NodeJS.Platform;
	arch: string;
	artifactTestSeam: boolean;
}

/** Only the packaged stable Windows x64 fork build checks GitHub; every other host is silent. */
export function forkUpdatesEnabled(input: ForkUpdateEnablement): boolean {
	if (!input.isPackaged || input.artifactTestSeam) return false;
	if (input.channel !== "stable") return false;
	return input.platform === "win32" && input.arch === "x64";
}
