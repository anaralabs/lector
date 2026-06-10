import { describe, expect, it } from "vitest";

import { createDarkModeColorMap, DEFAULT_DARK_MODE_COLORS } from "./dark-mode";

function hexToRgb(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

function luma([r, g, b]: [number, number, number]): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("createDarkModeColorMap", () => {
	const map = createDarkModeColorMap();

	it("maps white exactly onto the palette background", () => {
		expect(map("#ffffff")).toBe(DEFAULT_DARK_MODE_COLORS.background);
		expect(map("#fff")).toBe(DEFAULT_DARK_MODE_COLORS.background);
		expect(map("white")).toBe(DEFAULT_DARK_MODE_COLORS.background);
	});

	it("maps black exactly onto the palette foreground", () => {
		expect(map("#000000")).toBe(DEFAULT_DARK_MODE_COLORS.foreground);
		expect(map("#000")).toBe(DEFAULT_DARK_MODE_COLORS.foreground);
		expect(map("black")).toBe(DEFAULT_DARK_MODE_COLORS.foreground);
	});

	it("maps rgb() whites onto (approximately) the background pole", () => {
		const out = hexToRgb(map("rgb(255, 255, 255)"));
		const pole = hexToRgb(DEFAULT_DARK_MODE_COLORS.background);
		for (let i = 0; i < 3; i++) {
			expect(Math.abs(out[i]! - pole[i]!)).toBeLessThanOrEqual(1);
		}
	});

	it("flips lightness while preserving hue (red stays reddish, gets lighter)", () => {
		const out = hexToRgb(map("#ff0000"));
		// still red-dominant
		expect(out[0]).toBeGreaterThan(out[1]);
		expect(out[0]).toBeGreaterThan(out[2]);
		// red is dark (luma 54/255) so it must come out lighter
		expect(luma(out)).toBeGreaterThan(luma([255, 0, 0]));
	});

	it("turns dark blue into a light blue (readable links)", () => {
		const out = hexToRgb(map("#0000ff"));
		expect(out[2]).toBeGreaterThan(out[0]);
		expect(luma(out)).toBeGreaterThan(140);
	});

	it("darkens light colors and lightens dark colors monotonically", () => {
		const light = luma(hexToRgb(map("#eeeeee")));
		const mid = luma(hexToRgb(map("#808080")));
		const dark = luma(hexToRgb(map("#222222")));
		expect(dark).toBeGreaterThan(mid);
		expect(mid).toBeGreaterThan(light);
	});

	it("preserves alpha", () => {
		const out = map("#ff000080");
		expect(out).toMatch(/^#[0-9a-f]{8}$/);
		expect(Number.parseInt(out.slice(7, 9), 16)).toBe(0x80);
	});

	it("leaves fully transparent and unparseable colors unchanged", () => {
		expect(map("transparent")).toBe("transparent");
		expect(map("rgba(0, 0, 0, 0)")).toBe("rgba(0, 0, 0, 0)");
		expect(map("url(#pattern)")).toBe("url(#pattern)");
		expect(map("not-a-color")).toBe("not-a-color");
	});

	it("maps the full CSS color grammar via browser normalization", () => {
		// Near-white named/functional colors must land near the dark pole so
		// the CSS fallback background never flashes light (review finding).
		for (const input of ["ivory", "hsl(0 0% 98%)", "hsl(0, 0%, 100%)"]) {
			const out = hexToRgb(map(input));
			expect(luma(out)).toBeLessThan(50);
		}
		expect(luma(hexToRgb(map("navy")))).toBeGreaterThan(luma([0, 0, 128]));
	});

	it("emits only in-gamut css colors for saturated inputs", () => {
		for (const input of ["#00ff00", "#ff00ff", "#ffff00", "#00ffff"]) {
			expect(map(input)).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	it("returns the same map instance per palette with stable results", () => {
		// Function identity is the observable memoization contract (hooks use
		// it as an effect dependency); the per-color string cache is an
		// internal perf detail that string equality cannot distinguish.
		expect(createDarkModeColorMap()).toBe(map);
		expect(map("#123456")).toBe(map("#123456"));
		const custom = createDarkModeColorMap({ background: "#000000" });
		expect(custom).not.toBe(map);
		expect(custom("#ffffff")).toBe("#000000");
	});

	it("respects a custom palette's poles", () => {
		const custom = createDarkModeColorMap({
			background: "#1e2228",
			foreground: "#d6d3cd",
		});
		expect(custom("#ffffff")).toBe("#1e2228");
		expect(custom("#000000")).toBe("#d6d3cd");
	});
});
