import { expect, test } from "bun:test";
import { compareForkVersion, forkReleaseUrl, parseForkRelease } from "./release";

function release(version: string) {
	return { version, tag: `v${version}` };
}

test("parses only strict fork release tags", () => {
	expect(
		parseForkRelease({ tag_name: "v0.3.0.1a2b3c4d", draft: false, prerelease: false }),
	).toEqual(release("0.3.0.1a2b3c4d"));
	expect(parseForkRelease({ tag_name: "0.3.0.1a2b3c4d" })).toEqual(release("0.3.0.1a2b3c4d"));
	for (const tag of [
		"v0.3.0",
		"v0.3.0.1A2B3C4D",
		"v0.3.0.1a2b3c4",
		"v0.3.0.1a2b3c4dd",
		"v01.3.0.1a2b3c4d",
		"release-0.3.0.1a2b3c4d",
	]) {
		expect(parseForkRelease({ tag_name: tag, draft: false, prerelease: false })).toBeNull();
	}
});

test("ignores draft, prerelease and malformed payloads", () => {
	expect(parseForkRelease(null)).toBeNull();
	expect(parseForkRelease([])).toBeNull();
	expect(parseForkRelease({})).toBeNull();
	expect(parseForkRelease({ tag_name: 42 })).toBeNull();
	expect(parseForkRelease({ tag_name: "v0.3.0.1a2b3c4d", draft: true })).toBeNull();
	expect(parseForkRelease({ tag_name: "v0.3.0.1a2b3c4d", prerelease: true })).toBeNull();
});

test("offers a larger base version regardless of sha", () => {
	expect(compareForkVersion("0.2.9.aaaaaaaa", release("0.3.0.bbbbbbbb"))).toBe("newer");
	expect(compareForkVersion("0.2.9.aaaaaaaa", release("0.3.0.aaaaaaaa"))).toBe("newer");
	expect(compareForkVersion("1.0.0.aaaaaaaa", release("2.0.0.00000000"))).toBe("newer");
});

test("never offers a downgrade", () => {
	expect(compareForkVersion("0.3.0.aaaaaaaa", release("0.2.9.bbbbbbbb"))).toBe("older");
	expect(compareForkVersion("2.0.0.aaaaaaaa", release("1.99.99.bbbbbbbb"))).toBe("older");
});

test("an equal base counts only when the fork sha differs", () => {
	expect(compareForkVersion("0.3.0.aaaaaaaa", release("0.3.0.aaaaaaaa"))).toBe("same");
	expect(compareForkVersion("0.3.0.aaaaaaaa", release("0.3.0.bbbbbbbb"))).toBe("newer");
});

test("an unparsable current version yields no verdict", () => {
	expect(compareForkVersion("0.0.0-dev", release("0.3.0.aaaaaaaa"))).toBe("unknown");
	expect(compareForkVersion("not-a-version", release("0.3.0.aaaaaaaa"))).toBe("unknown");
});

test("composes the release page locally from the validated tag", () => {
	expect(forkReleaseUrl("v0.3.0.1a2b3c4d")).toBe(
		"https://github.com/caozisheng/oh-my-thinkrail/releases/tag/v0.3.0.1a2b3c4d",
	);
});
