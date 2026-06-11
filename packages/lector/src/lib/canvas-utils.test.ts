import { describe, expect, it } from "vitest";

import {
	BASE_ZOOM_STEP,
	clampScaleForPage,
	computeBaseScale,
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
	it("quantizes zoom upward so many zoom values share one scale", () => {
		const low = computeBaseScale(1, 1.0 + 1e-6, LETTER.width, LETTER.height);
		const high = computeBaseScale(
			1,
			1.0 + BASE_ZOOM_STEP - 1e-6,
			LETTER.width,
			LETTER.height,
		);
		expect(low).toBe(high);
	});

	it("is never below dpr * zoom until the budget clamps", () => {
		const budget = getCanvasPixelBudget();
		for (const zoom of [0.4, 0.75, 1, 1.3, 2, 3.7]) {
			const scale = computeBaseScale(2, zoom, LETTER.width, LETTER.height);
			const unclamped =
				LETTER.width * LETTER.height * (2 * zoom) ** 2 <= budget;
			if (unclamped) {
				expect(scale).toBeGreaterThanOrEqual(2 * zoom - 1e-9);
			}
		}
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

	it("keeps a floor of half a zoom step for tiny zooms", () => {
		const scale = computeBaseScale(2, 0.01, LETTER.width, LETTER.height);
		expect(scale).toBeCloseTo(2 * BASE_ZOOM_STEP, 6);
	});
});
