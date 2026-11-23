import { expect, test } from "bun:test";
import { EN } from "@thinkrail/locales";
import { renderToStaticMarkup } from "react-dom/server";
import { MatrixSettings } from "./MatrixSettings";

// MatrixSettings is store/transport-backed; this source-level/static check pins its Settings markup contract.
test("Matrix integration settings have catalog rows, accessible explicit controls and masked secret input", () => {
	const source = require("node:fs").readFileSync(
		new URL("./MatrixSettings.tsx", import.meta.url),
		"utf8",
	);
	expect(source).toContain('settingId="matrix-integration"');
	expect(source).toContain("SETTINGS_INPUT");
	expect(source).toContain('type="password"');
	expect(source).toContain("aria-label={secretName}");
	expect(source).toContain("tabIndex={0}");
	expect(source).toContain("<ConfirmDialog");
	expect(source).toContain("onOpenChange={setConfirmDisconnect}");
	expect(source).not.toContain('tone="neutral"');
	expect(source).not.toContain("window.confirm");
	expect(source).not.toContain("finally {");
	expect(EN["settings.matrix.password"]).toBeDefined();
	expect(EN["settings.matrix.accessToken"]).toBeDefined();
	expect(MatrixSettings).toBeDefined();
	expect(renderToStaticMarkup).toBeDefined();
});
