import type { IssueLabelColor } from "@thinkrail/contracts";

const BLACK = `#${"0".repeat(6)}`;
const WHITE = `#${"F".repeat(6)}`;

export interface IssueLabelStyle {
	background: string;
	foreground: string;
}

function normalizedHex(value: unknown): string | null {
	return typeof value === "string" && /^#?[a-fA-F0-9]{6}$/.test(value)
		? `#${value.replace(/^#/, "").toUpperCase()}`
		: null;
}

function luminance(hex: string): number {
	const channels = hex
		.slice(1)
		.match(/.{2}/g)
		?.map((channel) => {
			const value = Number.parseInt(channel, 16) / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2;
		});
	if (channels?.length !== 3) return 0;
	return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(a: string, b: string): number {
	const [light = 1, dark = 0] = [luminance(a), luminance(b)].sort((left, right) => right - left);
	return (light + 0.05) / (dark + 0.05);
}

export function labelTextColor(background: string, preferred?: string): string {
	const validBackground = normalizedHex(background);
	if (!validBackground) return "";
	const validPreferred = normalizedHex(preferred);
	if (validPreferred && contrast(validBackground, validPreferred) >= 4.5) return validPreferred;
	return contrast(validBackground, BLACK) >= contrast(validBackground, WHITE) ? BLACK : WHITE;
}

export function issueLabelColors(
	metadata: readonly IssueLabelColor[] | undefined,
	labels: readonly string[],
): Record<string, IssueLabelStyle> {
	const names = new Set(labels);
	const result: Record<string, IssueLabelStyle> = {};
	for (const entry of metadata ?? []) {
		const background = normalizedHex(entry.color);
		if (!names.has(entry.name) || !background) continue;
		const foreground = labelTextColor(background, entry.textColor);
		result[entry.name] = { background, foreground };
	}
	return result;
}
