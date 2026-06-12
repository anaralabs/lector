import { describe, expect, it } from "vitest";

import {
	clampScaleForPage,
	computeBaseScale,
	computeTargetScale,
	getCanvasPixelBudget,
	MAX_CANVAS_PIXELS,
} from "./canvas-utils";

const LETTER = { width: 612, height: 792 };

describe("clampScaleForPage", () => {
	it("passes the target scale through when the page fits the budget", () => {
		expect(clampScaleForPage(2, LETTER.width, LETTER.height)).toBe(2);
	});

	it("clamps the scale so width * height * scale^2 never exceeds maxPixels", () => {
		const scale = clampScaleForPage(100, LETTER.width, LETTER.height);
		const pixels = LETTER.width * scale * (LETTER.height * scale);
		expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS * (1 + 1e-9));
		expect(scale).toBeCloseTo(
			Math.sqrt(MAX_CANVAS_PIXELS / (LETTER.width * LETTER.height)),
			6,
		);
	});

	it("respects a custom maxPixels budget", () => {
		const budget = 1_000_000;
		const scale = clampScaleForPage(10, 1000, 1000, budget);
		expect(scale).toBeCloseTo(1, 6);
	});

	it("returns 0 for a zero target scale", () => {
		expect(clampScaleForPage(0, LETTER.width, LETTER.height)).toBe(0);
	});
});

describe("getCanvasPixelBudget", () => {
	it("never exceeds MAX_CANVAS_PIXELS", () => {
		expect(getCanvasPixelBudget()).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
	});

	it("is positive", () => {
		expect(getCanvasPixelBudget()).toBeGreaterThan(0);
	});
});

describe("computeBaseScale", () => {
	it("is exactly the target scale until the budget clamps: native at zoom <= 1, supersampled above", () => {
		const budget = getCanvasPixelBudget();
		for (const zoom of [0.4, 0.75, 0.8, 0.9, 1, 1.13, 1.3, 2, 3.7]) {
			const scale = computeBaseScale(2, zoom, LETTER.width, LETTER.height);
			const target = computeTargetScale(2, zoom);
			const unclamped = LETTER.width * LETTER.height * target ** 2 <= budget;
			if (unclamped) {
				expect(scale).toBeCloseTo(target, 9);
			}
		}
	});

	it("renders native 1:1 at zoom <= 1 and supersampled above", () => {
		expect(computeTargetScale(2, 1)).toBeCloseTo(2, 9);
		expect(computeTargetScale(2, 0.8)).toBeCloseTo(1.6, 9);
		expect(computeTargetScale(2, 1.5)).toBeCloseTo(2 * 1.5 * 1.3, 9);
	});

	it("never allocates past the adaptive budget", () => {
		const budget = getCanvasPixelBudget();
		for (const zoom of [1, 2, 5, 10]) {
			const scale = computeBaseScale(3, zoom, LETTER.width, LETTER.height);
			const pixels = LETTER.width * scale * (LETTER.height * scale);
			expect(pixels).toBeLessThanOrEqual(budget * (1 + 1e-9));
		}
	});

	it("is monotonically non-decreasing in zoom", () => {
		let prev = 0;
		for (const zoom of [0.25, 0.5, 1, 1.5, 2, 3, 5, 8]) {
			const scale = computeBaseScale(2, zoom, LETTER.width, LETTER.height);
			expect(scale).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = scale;
		}
	});

	it("keeps a small floor for degenerate zooms", () => {
		const scale = computeBaseScale(2, 0, LETTER.width, LETTER.height);
		expect(scale).toBeCloseTo(2 * 0.01, 6);
		expect(computeTargetScale(2, Number.NaN)).toBeCloseTo(2 * 0.01, 6);
		// real low zooms are exact, not floored
		expect(computeTargetScale(2, 0.05)).toBeCloseTo(0.1, 9);
	});
});
