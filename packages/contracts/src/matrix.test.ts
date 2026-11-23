import { expect, test } from "bun:test";
import { canonicalMatrixHomeserver, isMatrixConnectionInput, isMatrixUserId } from "./matrix";

test("canonicalizes clean HTTP(S) origins without granting network access", () => {
	expect(canonicalMatrixHomeserver("http://matrix.example:9527/")).toBe(
		"http://matrix.example:9527",
	);
	expect(canonicalMatrixHomeserver("https://matrix.example/")).toBe("https://matrix.example");
	for (const value of [
		"https://user@matrix.example",
		"https://matrix.example/path",
		"https://matrix.example/?x=1",
		"https://matrix.example\\@127.0.0.1",
	]) {
		expect(canonicalMatrixHomeserver(value)).toBeNull();
	}
});

test("accepts an exact, secret-bearing login input but rejects ambiguous identities and extra keys", () => {
	const input = {
		operationId: "login_01",
		homeserver: "https://matrix.example",
		botUserId: "@thinkrail:example.org",
		controllerUserId: "@owner:example.org",
		plaintextAcknowledged: true,
		mode: "password",
		password: "temporary-secret",
	};
	expect(isMatrixConnectionInput(input)).toBe(true);
	const http = { ...input, homeserver: "http://matrix.example:9527" };
	expect(isMatrixConnectionInput(http)).toBe(false);
	expect(isMatrixConnectionInput({ ...input, homeserver: "http:matrix.example:9527" })).toBe(false);
	expect(
		isMatrixConnectionInput({ ...http, networkConsent: { homeserver: http.homeserver } }),
	).toBe(true);
	expect(
		isMatrixConnectionInput({
			...http,
			networkConsent: { homeserver: "http://matrix.example:9528" },
		}),
	).toBe(false);
	expect(isMatrixConnectionInput({ ...http, networkConsent: undefined })).toBe(false);
	expect(
		isMatrixConnectionInput({
			...http,
			homeserver: "http:matrix.example:9527",
			networkConsent: { homeserver: "http://matrix.example:9527" },
		}),
	).toBe(false);
	expect(isMatrixConnectionInput({ ...input, accessToken: "also-secret" })).toBe(false);
	expect(isMatrixConnectionInput({ ...input, controllerUserId: input.botUserId })).toBe(false);
	expect(isMatrixConnectionInput({ ...input, plaintextAcknowledged: false })).toBe(false);
	expect(isMatrixUserId("@owner:example.org")).toBe(true);
	expect(isMatrixUserId("owner:example.org")).toBe(false);
});
