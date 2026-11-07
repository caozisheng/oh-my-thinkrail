import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import * as ResEdit from "resedit";
import {
	BRAND_MARK_PATH,
	BRAND_MARK_SEGMENTS,
	BRAND_MARK_VIEW_BOX,
} from "../../../apps/web/src/constants/brandMark.generated";

const assets = join(import.meta.dir, "../assets");
const svg = readFileSync(join(assets, "icon.svg"), "utf8");

test("OMT native and web surfaces use the same transparent green master", () => {
	expect(readFileSync(join(import.meta.dir, "../../../apps/web/public/favicon.svg"), "utf8")).toBe(
		svg,
	);
	expect(svg).toContain(`viewBox="${BRAND_MARK_VIEW_BOX}"`);
	expect(Object.keys(BRAND_MARK_SEGMENTS)).toEqual(["o", "m", "tBar", "tStem", "tRight"]);
	for (const d of Object.values(BRAND_MARK_SEGMENTS)) expect(svg).toContain(`d="${d}"`);
	expect(BRAND_MARK_PATH).toBe(Object.values(BRAND_MARK_SEGMENTS).join(""));
	expect(svg).not.toMatch(/<rect|#000|background[:=]/);
});

test("native PNG and every ICO frame are generated from the transparent master", () => {
	const render = (size: number) =>
		new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();
	const image = render(512);
	expect(readFileSync(join(assets, "icon.png"))).toEqual(image.asPng());
	const pixels = image.pixels;
	expect(pixels[3]).toBe(0);
	let opaque = 0;
	const colours = new Set<string>();
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i + 3] !== 255) continue;
		opaque++;
		colours.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
	}
	expect(opaque).toBeGreaterThan(1000);
	expect([...colours]).toEqual(["141,255,79"]);
	const ico = ResEdit.Data.IconFile.from(readFileSync(join(assets, "icon.ico")));
	expect(ico.icons.map(({ data }) => data.width)).toEqual([
		256, 128, 80, 72, 64, 56, 48, 40, 36, 32, 28, 24, 20, 16,
	]);
	for (const { data } of ico.icons)
		expect(Buffer.from(data.bin)).toEqual(render(data.width).asPng());
});
