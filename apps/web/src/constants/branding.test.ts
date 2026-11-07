import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_MARK_PATH, BRAND_MARK_SEGMENTS, BRAND_MARK_VIEW_BOX } from "./brandMark.generated";

const svg = readFileSync(
	join(import.meta.dir, "../../../../packages/shared/assets/icon.svg"),
	"utf8",
);

test("the browser tab uses the fork name and the OMT favicon", () => {
	const html = readFileSync(join(import.meta.dir, "../../index.html"), "utf8");
	expect(html).toContain("<title>oh-my-thinkrail</title>");
	expect(html).toContain('href="/favicon.svg"');
});

test("OMT native and web surfaces use the same transparent green master", () => {
	expect(readFileSync(join(import.meta.dir, "../../public/favicon.svg"), "utf8")).toBe(svg);
	expect(svg).toContain(`viewBox="${BRAND_MARK_VIEW_BOX}"`);
	expect(Object.keys(BRAND_MARK_SEGMENTS)).toEqual(["o", "m", "tBar", "tStem", "tRight"]);
	for (const d of Object.values(BRAND_MARK_SEGMENTS)) expect(svg).toContain(`d="${d}"`);
	expect(BRAND_MARK_PATH).toBe(Object.values(BRAND_MARK_SEGMENTS).join(""));
	expect(svg).not.toMatch(/<rect|#000|background[:=]/);
});
