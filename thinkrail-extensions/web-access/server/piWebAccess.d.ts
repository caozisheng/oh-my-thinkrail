import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

declare const piWebAccess: ExtensionFactory &
	((pi: ExtensionAPI, allowRanges?: readonly string[]) => Promise<void>);
export default piWebAccess;
