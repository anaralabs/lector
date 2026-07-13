import { describe, expect, it } from "vitest";

import { applyContextRecolor } from "./recolor-context";
import { isScanPaperSource } from "./scan-invert";

const DARK = "#181a1b";
const LIGHT = "#e8e6e3";

/** Test map mirroring the dark scheme's poles. */
const testMap = (color: string) =>
	color === "#ffffff" || color === "white"
		? DARK
		: color === "#000000" || color === "black"
			? LIGHT
			: color;

// NTSC luma of the mapped white pole (#181a1b): where scan paper must land.
const POLE_LUMA = 0.3 * 0x18 + 0.59 * 0x1a + 0.11 * 0x1b;

function makeCtx(size = 100): CanvasRenderingContext2D {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	return ctx;
}

function rgbAt(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
): [number, number, number] {
	const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
	return [r!, g!, b!];
}

/** White "scan paper" with a black ink bar across the middle. */
function makeScanSource(size = 100): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = "#000000";
	ctx.fillRect(0, Math.floor(size / 2) - 2, size, 4);
	return canvas;
}

function makeColorfulSource(size = 100): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#c03020";
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = "#2040c0";
	ctx.fillRect(0, size / 2, size, size / 2);
	return canvas;
}

describe("isScanPaperSource", () => {
	it("accepts white paper with ink", () => {
		expect(isScanPaperSource(makeScanSource())).toBe(true);
	});

	it("rejects colorful sources", () => {
		expect(isScanPaperSource(makeColorfulSource())).toBe(false);
	});

	it("rejects transparent sources", () => {
		const canvas = document.createElement("canvas");
		canvas.width = 50;
		canvas.height = 50;
		expect(isScanPaperSource(canvas)).toBe(false);
	});
});

describe("scan inversion via applyContextRecolor", () => {
	it("inverts a page-covering scan toward the palette poles", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);

		const [pr, pg, pb] = rgbAt(ctx, 10, 10); // paper
		const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
		expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);

		const [ir, ig, ib] = rgbAt(ctx, 50, 50); // ink bar
		expect(Math.min(ir, ig, ib)).toBeGreaterThan(200);
	});

	it("keeps colorful full-page images untouched (photos stay photos)", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeColorfulSource(), 0, 0, 100, 100);
		const [r, g, b] = rgbAt(ctx, 10, 10);
		expect(r).toBeGreaterThan(150);
		expect(g).toBeLessThan(100);
		expect(b).toBeLessThan(100);
	});

	it("keeps small white images untouched (figures, screenshots)", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeScanSource(), 0, 0, 30, 30);
		const [r, g, b] = rgbAt(ctx, 10, 10);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
	});

	it("does nothing without pageArea (scratch canvases)", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap);
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		const [r, g, b] = rgbAt(ctx, 10, 10);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
	});

	it("counts coverage through the current transform", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.save();
		ctx.scale(2, 2);
		// 50x50 draw × 2x scale = full page
		ctx.drawImage(makeScanSource(), 0, 0, 50, 50);
		ctx.restore();
		const [pr, pg, pb] = rgbAt(ctx, 10, 10);
		const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
		expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);
	});

	it("skips non-source-over composites and translucent draws", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.globalAlpha = 0.5;
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		ctx.globalAlpha = 1;
		const [r, g, b] = rgbAt(ctx, 10, 10);
		expect(Math.min(r, g, b)).toBeGreaterThan(200);
	});

	it("leaves the context state untouched after inverting", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.fillStyle = "#123456";
		ctx.globalCompositeOperation = "source-over";
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		expect(ctx.fillStyle).toBe("#123456");
		expect(ctx.globalCompositeOperation).toBe("source-over");
		expect(ctx.globalAlpha).toBe(1);
	});

	it("restores pristine drawImage on cleanup", () => {
		const ctx = makeCtx(100);
		const cleanup = applyContextRecolor(ctx, testMap, {
			pageArea: 100 * 100,
		});
		cleanup();
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		const [r, g, b] = rgbAt(ctx, 10, 10);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
	});
});
