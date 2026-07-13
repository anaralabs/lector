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

/** White page with a saturated chart block covering ~30%. */
function makeChartSlideSource(size = 100): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = "#e04010";
	ctx.fillRect(size * 0.1, size * 0.1, size * 0.6, size * 0.5);
	return canvas;
}

/** Mostly-white source with a transparent cut-out covering ~20%. */
function makeCutOutSource(size = 100): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, size, size);
	ctx.clearRect(size * 0.3, size * 0.3, size * 0.45, size * 0.45);
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

	it("rejects white pages with a saturated chart block", () => {
		expect(isScanPaperSource(makeChartSlideSource())).toBe(false);
	});

	it("rejects sources with transparent cut-outs", () => {
		expect(isScanPaperSource(makeCutOutSource())).toBe(false);
	});

	it("samples only the cropped region when a crop is given", () => {
		// left half scan paper, right half saturated color
		const canvas = document.createElement("canvas");
		canvas.width = 200;
		canvas.height = 100;
		const ctx = canvas.getContext("2d")!;
		ctx.drawImage(makeScanSource(100), 0, 0);
		ctx.fillStyle = "#c03020";
		ctx.fillRect(100, 0, 100, 100);
		expect(isScanPaperSource(canvas)).toBe(false);
		expect(isScanPaperSource(canvas, { sx: 0, sy: 0, sw: 100, sh: 100 })).toBe(
			true,
		);
		expect(
			isScanPaperSource(canvas, { sx: 100, sy: 0, sw: 100, sh: 100 }),
		).toBe(false);
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

	it("inverts a cropped scan drawn from a mixed scratch canvas", () => {
		const mixed = document.createElement("canvas");
		mixed.width = 200;
		mixed.height = 100;
		const mctx = mixed.getContext("2d")!;
		mctx.drawImage(makeScanSource(100), 0, 0);
		mctx.fillStyle = "#c03020";
		mctx.fillRect(100, 0, 100, 100);

		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(mixed, 0, 0, 100, 100, 0, 0, 100, 100);
		const [pr, pg, pb] = rgbAt(ctx, 10, 10);
		const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
		expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);
	});

	it("does not invert white pages carrying a saturated chart", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeChartSlideSource(), 0, 0, 100, 100);
		const [r, g, b] = rgbAt(ctx, 95, 95);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
	});

	it("tints inverted paper toward a colored palette background", () => {
		const BLUE_DARK = "#001b33";
		const blueMap = (color: string) =>
			color === "#ffffff" || color === "white"
				? BLUE_DARK
				: color === "#000000" || color === "black"
					? LIGHT
					: color;
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, blueMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		const [r, , b] = rgbAt(ctx, 10, 10);
		// paper must carry the palette's blue hue, not neutral gray
		expect(b).toBeGreaterThan(r + 8);
	});

	it("pins ink to the foreground pole on asymmetric palettes", () => {
		// black background, mid-gray foreground: without the remap, ink would
		// land at 255 instead of the configured 200.
		const asymmetricMap = (color: string) =>
			color === "#ffffff" || color === "white"
				? "#000000"
				: color === "#000000" || color === "black"
					? "#c8c8c8"
					: color;
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, asymmetricMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		const [pr, pg, pb] = rgbAt(ctx, 10, 10); // paper → background pole (0)
		expect(Math.max(pr, pg, pb)).toBeLessThan(12);
		const [ir, ig, ib] = rgbAt(ctx, 50, 50); // ink → foreground pole (200)
		const inkLuma = 0.3 * ir + 0.59 * ig + 0.11 * ib;
		expect(Math.abs(inkLuma - 200)).toBeLessThan(12);
	});

	it("inverts tiled scans once the strips paper the page", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		// two half-page strips, neither passes the per-draw coverage gate
		ctx.drawImage(makeScanSource(), 0, 0, 100, 50, 0, 0, 100, 50);
		ctx.drawImage(makeScanSource(), 0, 50, 100, 50, 0, 50, 100, 50);
		for (const y of [10, 90]) {
			const [pr, pg, pb] = rgbAt(ctx, 10, y);
			const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
			expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);
		}
	});

	it("does not invert scattered white figures on a text page", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		// four white screenshots totalling ~81% of the page, but separated by
		// gutters — the density guard must keep them un-inverted
		ctx.drawImage(makeScanSource(), 0, 0, 45, 45);
		ctx.drawImage(makeScanSource(), 55, 0, 45, 45);
		ctx.drawImage(makeScanSource(), 0, 55, 45, 45);
		ctx.drawImage(makeScanSource(), 55, 55, 45, 45);
		const [r, g, b] = rgbAt(ctx, 10, 10);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
	});

	it("rejects semi-transparent white overlays", () => {
		const source = document.createElement("canvas");
		source.width = 100;
		source.height = 100;
		const sctx = source.getContext("2d")!;
		sctx.globalAlpha = 0.8;
		sctx.fillStyle = "#ffffff";
		sctx.fillRect(0, 0, 100, 100);
		expect(isScanPaperSource(source)).toBe(false);
	});

	it("rejects pure-white rasters (MRC background layers, blank pages)", () => {
		const source = document.createElement("canvas");
		source.width = 100;
		source.height = 100;
		const sctx = source.getContext("2d")!;
		sctx.fillStyle = "#ffffff";
		sctx.fillRect(0, 0, 100, 100);
		expect(isScanPaperSource(source)).toBe(false);
		// with ink present it qualifies again
		expect(isScanPaperSource(makeScanSource())).toBe(true);
	});

	it("leaves white overlays on already-inverted paper alone", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100); // inverted
		ctx.drawImage(makeScanSource(), 10, 60, 30, 30); // logo/QR overlay
		const [r, g, b] = rgbAt(ctx, 15, 65); // inside the overlay
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
	});

	it("tolerates seam-avoidance overlap between strips", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		// strips overlap by 2px — real rasterizers do this to avoid seams
		ctx.drawImage(makeScanSource(), 0, 0, 100, 52, 0, 0, 100, 52);
		ctx.drawImage(makeScanSource(), 0, 50, 100, 50, 0, 50, 100, 50);
		// paper on both strips lands on the pole
		for (const y of [10, 90]) {
			const [pr, pg, pb] = rgbAt(ctx, 10, y);
			const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
			expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);
		}
		// the seam row lands on the source's ink bar: inverted once it reads
		// light (~230); a double inversion would flip it back to dark
		const [ir, ig, ib] = rgbAt(ctx, 10, 51);
		expect(Math.min(ir, ig, ib)).toBeGreaterThan(200);
	});

	it("counts blank margin strips toward tiled coverage", () => {
		const blank = document.createElement("canvas");
		blank.width = 100;
		blank.height = 30;
		const bctx = blank.getContext("2d")!;
		bctx.fillStyle = "#ffffff";
		bctx.fillRect(0, 0, 100, 30);

		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(blank, 0, 0); // blank top margin, 30%
		// inked strips carrying the rest of the page
		ctx.drawImage(makeScanSource(), 0, 30, 100, 40, 0, 30, 100, 40);
		ctx.drawImage(makeScanSource(), 0, 62, 100, 30, 0, 70, 100, 30);
		// paper samples avoid the source ink bar (rows 48-52 land at y≈50)
		for (const y of [10, 45, 90]) {
			const [pr, pg, pb] = rgbAt(ctx, 10, y);
			const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
			expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);
		}
	});

	it("abandons retroactive inversion when vector content interleaves strips", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeScanSource(), 0, 22, 100, 30, 0, 0, 100, 30);
		// a vector annotation lands on the first strip…
		ctx.fillStyle = "#ff0000";
		ctx.fillRect(10, 10, 20, 5);
		// …then the remaining strips arrive
		ctx.drawImage(makeScanSource(), 0, 30, 100, 40, 0, 30, 100, 40);
		ctx.drawImage(makeScanSource(), 0, 62, 100, 30, 0, 70, 100, 30);
		// retro inversion would have flipped the annotation — page stays light
		const [r, g, b] = rgbAt(ctx, 50, 5);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
		const [ar, ag, ab] = rgbAt(ctx, 15, 12); // annotation untouched
		expect(ar).toBeGreaterThan(150);
		expect(Math.max(ag, ab)).toBeLessThan(100);
	});

	it("flushes accumulated strips when a page-covering draw arrives", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		// a strip that only covers the top 30% accumulates… (its source crop
		// straddles the ink bar so it reads as inked scan paper)
		ctx.drawImage(makeScanSource(), 0, 22, 100, 30, 0, 0, 100, 30);
		// …then a draw covering the remaining 70% triggers the immediate path
		ctx.drawImage(makeScanSource(), 0, 30, 100, 70, 0, 30, 100, 70);
		for (const y of [10, 90]) {
			const [pr, pg, pb] = rgbAt(ctx, 10, y);
			const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
			expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);
		}
	});

	it("keeps clipped draws inside their clip when inverting", () => {
		const ctx = makeCtx(100);
		// pre-fill white before wrapping so the fill isn't recolored
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, 100, 100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, 40, 40);
		ctx.clip();
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		ctx.restore();
		const [ir, ig, ib] = rgbAt(ctx, 10, 10); // inside clip: inverted
		const insideLuma = 0.3 * ir + 0.59 * ig + 0.11 * ib;
		expect(Math.abs(insideLuma - POLE_LUMA)).toBeLessThan(4);
		const [or_, og, ob] = rgbAt(ctx, 80, 80); // outside clip: untouched
		expect(Math.min(or_, og, ob)).toBeGreaterThan(240);
	});

	it("abandons retroactive inversion when a photo interleaves strips", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		ctx.drawImage(makeScanSource(), 0, 22, 100, 30, 0, 0, 100, 30);
		// a small photo lands between strips — retro fill would invert it
		ctx.drawImage(makeColorfulSource(), 40, 5, 20, 15);
		ctx.drawImage(makeScanSource(), 0, 30, 100, 40, 0, 30, 100, 40);
		ctx.drawImage(makeScanSource(), 0, 62, 100, 30, 0, 70, 100, 30);
		const [r, g, b] = rgbAt(ctx, 10, 5); // paper stays light
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
		const [pr, pg] = rgbAt(ctx, 45, 8); // photo untouched
		expect(pr).toBeGreaterThan(150);
		expect(pg).toBeLessThan(100);
	});

	it("keeps retroactive fills out of clip-inverted regions", () => {
		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		// a pending strip accumulates…
		ctx.drawImage(makeScanSource(), 0, 22, 100, 30, 0, 0, 100, 30);
		// …then a clipped page-covering scan inverts part of that strip
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, 100, 20);
		ctx.clip();
		ctx.drawImage(makeScanSource(), 0, 0, 100, 100);
		ctx.restore();
		// …then the rest of the page arrives and triggers the retro fill
		ctx.drawImage(makeScanSource(), 0, 30, 100, 40, 0, 30, 100, 40);
		ctx.drawImage(makeScanSource(), 0, 62, 100, 30, 0, 70, 100, 30);
		// the clip-inverted region must not be difference-filled again
		const [cr, cg, cb] = rgbAt(ctx, 10, 10);
		const clippedLuma = 0.3 * cr + 0.59 * cg + 0.11 * cb;
		expect(Math.abs(clippedLuma - POLE_LUMA)).toBeLessThan(6);
	});

	it("abandons strips repainted by an MRC white layer", () => {
		const white = document.createElement("canvas");
		white.width = 100;
		white.height = 100;
		const wctx = white.getContext("2d")!;
		wctx.fillStyle = "#ffffff";
		wctx.fillRect(0, 0, 100, 100);

		const ctx = makeCtx(100);
		applyContextRecolor(ctx, testMap, { pageArea: 100 * 100 });
		// a strip accumulates, then a pure-white page-covering layer repaints
		ctx.drawImage(makeScanSource(), 0, 22, 100, 30, 0, 0, 100, 30);
		ctx.drawImage(white, 0, 0);
		// fresh inked strips cover the lower 70% and invert normally
		ctx.drawImage(makeScanSource(), 0, 30, 100, 40, 0, 30, 100, 40);
		ctx.drawImage(makeScanSource(), 0, 62, 100, 30, 0, 70, 100, 30);
		// the white layer's region must NOT be retro-filled from stale strips
		const [r, g, b] = rgbAt(ctx, 10, 10);
		expect(Math.min(r, g, b)).toBeGreaterThan(240);
		const [pr, pg, pb] = rgbAt(ctx, 10, 90);
		const paperLuma = 0.3 * pr + 0.59 * pg + 0.11 * pb;
		expect(Math.abs(paperLuma - POLE_LUMA)).toBeLessThan(4);
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
