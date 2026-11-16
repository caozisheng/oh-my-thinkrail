import { removeTree } from "@thinkrail/shared/removeTree";
import { assertE2eTree } from "./fixtures/isolation";
import { E2E_BINARY_CACHE, E2E_DATA_DIR, E2E_DESKTOP_CACHE } from "./fixtures/paths";

export default function globalTeardown(): void {
	for (const root of [E2E_DATA_DIR, E2E_BINARY_CACHE, E2E_DESKTOP_CACHE]) assertE2eTree(root);
	removeTree(E2E_DATA_DIR);
	removeTree(E2E_BINARY_CACHE);
	removeTree(E2E_DESKTOP_CACHE);
}
