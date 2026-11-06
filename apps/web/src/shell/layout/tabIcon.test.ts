import { expect, test } from "bun:test";
import { RiNewspaperFill, RiNewspaperLine } from "@remixicon/react";
import { isValidElement, type ReactElement } from "react";
import { tabIcon } from "./tabIcon";
import type { LayoutTab } from "./types";

type IconProps = { className?: string };
function icon(tool: string, active = false): ReactElement<IconProps> {
	const node = tabIcon({ kind: "tool", tool } as LayoutTab, active);
	if (!isValidElement<IconProps>(node)) throw new Error(`${tool} must render exactly one icon`);
	return node;
}

/** The rail, the tab strip and the panel tabs all resolve their icon here. */
test("every tool icon swaps between Line and Fill when it becomes active", () => {
	for (const tool of ["projects", "specs", "files", "review", "issues", "plan"]) {
		expect(icon(tool, false).type).not.toBe(icon(tool, true).type);
	}
});

test("the Issues tool is a newspaper: hollow at rest, filled when selected", () => {
	const atRest = icon("issues");
	const active = icon("issues", true);
	expect(atRest.type).toBe(RiNewspaperLine);
	expect(active.type).toBe(RiNewspaperFill);
	// The rail's icon size travels through unchanged; only the glyph differs.
	expect(atRest.props.className).toBe("size-14 shrink-0");
	expect(active.props.className).toBe(atRest.props.className);
	const rail = icon("issues");
	expect(tabIcon({ kind: "tool", tool: "issues" } as LayoutTab)).toEqual(rail);
});
