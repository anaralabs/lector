import { describe, expect, it } from "vitest";

import { applyContextRecolor } from "./recolor-context";

const DARK = "#181a1b";
const LIGHT = "#e8e6e3";

/** Test map mirroring the dark scheme's poles. */
const testMap = (color: string) =>
	color === "#ffffff" || color === "white"
		? DARK
		: color === "#000000" || color === "black"
			? LIGHT
			: color;

function makeCtx(size = 8): CanvasRenderingContext2D {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	return ctx;
}

function pixel(ctx: CanvasRenderingContext2D, x = 4, y = 4): string {
	const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
	return `#${[r, g, b].map((c) => c!.toString(16).padStart(2, "0")).join("")}`;
}

describe("applyContextRecolor", () => {
	it("recolors string fills at draw time", () => {
		const ctx = makeCtx();
		applyContextRecolor(ctx, testMap);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, 8, 8);
		expect(pixel(ctx)).toBe(DARK);
	});

	it("recolors path fills and strokes", () => {
		const ctx = makeCtx();
		applyContextRecolor(ctx, testMap);
		ctx.fillStyle = "#000000";
		ctx.beginPath();
		ctx.rect(0, 0, 8, 8);
		ctx.fill();
		expect(pixel(ctx)).toBe(LIGHT);

		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 8;
		ctx.beginPath();
		ctx.moveTo(0, 4);
		ctx.lineTo(8, 4);
		ctx.stroke();
		expect(pixel(ctx)).toBe(DARK);
	});

	it("keeps readbacks in original colors (pdf.js copyCtxState contract)", () => {
		const ctx = makeCtx();
		applyContextRecolor(ctx, testMap);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, 8, 8);
		expect(ctx.fillStyle).toBe("#ffffff");

		// state copied to a second wrapped context must map exactly once
		const other = makeCtx();
		applyContextRecolor(other, testMap);
		other.fillStyle = ctx.fillStyle;
		other.fillRect(0, 0, 8, 8);
		expect(pixel(other)).toBe(DARK);
	});

	it("recolors gradient stops at creation", () => {
		const ctx = makeCtx();
		applyContextRecolor(ctx, testMap);
		const gradient = ctx.createLinearGradient(0, 0, 8, 0);
		gradient.addColorStop(0, "#ffffff");
		gradient.addColorStop(1, "#ffffff");
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, 8, 8);
		expect(pixel(ctx)).toBe(DARK);
	});

	it("does not touch drawImage pixels", () => {
		const source = makeCtx();
		source.fillStyle = "#ffffff";
		source.fillRect(0, 0, 8, 8);

		const ctx = makeCtx();
		applyContextRecolor(ctx, testMap);
		ctx.drawImage(source.canvas, 0, 0);
		expect(pixel(ctx)).toBe("#ffffff");
	});

	it("cleanup restores pristine behavior", () => {
		const ctx = makeCtx();
		const cleanup = applyContextRecolor(ctx, testMap);
		cleanup();
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, 8, 8);
		expect(pixel(ctx)).toBe("#ffffff");
		expect(Object.hasOwn(ctx, "fill")).toBe(false);
		expect(Object.hasOwn(ctx, "createLinearGradient")).toBe(false);
	});

	it("re-wrapping replaces the previous map; stale cleanup is a no-op", () => {
		const ctx = makeCtx();
		const cleanup1 = applyContextRecolor(ctx, () => "#ff0000");
		const cleanup2 = applyContextRecolor(ctx, testMap);
		cleanup1(); // superseded — must not unwrap
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, 8, 8);
		expect(pixel(ctx)).toBe(DARK);
		cleanup2();
		ctx.fillRect(0, 0, 8, 8);
		expect(pixel(ctx)).toBe("#ffffff");
	});

	it("luma-corrects luminosity soft-mask composition (pdf.js destination-in)", () => {
		// Reproduce pdf.js genericComposeSMask: mask drawn through a luminosity
		// filter with destination-in, so mask luma becomes layer alpha. The
		// mask art went through the recolor map (white -> dark), which without
		// correction would invert the mask.
		const svgNS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNS, "svg");
		svg.setAttribute("width", "0");
		svg.setAttribute("height", "0");
		const filter = document.createElementNS(svgNS, "filter");
		// Mirrors pdf.js's generated id shape: g_<docId>_luminosity_map_<n>
		filter.setAttribute("id", "g_test_luminosity_map_0");
		filter.setAttribute("color-interpolation-filters", "sRGB");
		const matrix = document.createElementNS(svgNS, "feColorMatrix");
		matrix.setAttribute("type", "matrix");
		matrix.setAttribute(
			"values",
			"0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0.3 0.59 0.11 0 0",
		);
		filter.append(matrix);
		svg.append(filter);
		document.body.append(svg);

		try {
			// Layer: fully opaque content, color untouched by the test map.
			const layer = makeCtx();
			applyContextRecolor(layer, testMap);
			layer.fillStyle = "#ff0000";
			layer.fillRect(0, 0, 8, 8);

			// Mask: "fully visible" mask art = white, painted through the map
			// (lands as the dark background color, luma ~0.1).
			const mask = makeCtx();
			applyContextRecolor(mask, testMap);
			mask.fillStyle = "#ffffff";
			mask.fillRect(0, 0, 8, 8);
			expect(pixel(mask)).toBe(DARK);

			layer.save();
			layer.filter = "url(#g_test_luminosity_map_0)";
			layer.globalCompositeOperation = "destination-in";
			layer.drawImage(mask.canvas, 0, 0);
			layer.restore();

			// Corrected: mapped-white luma is restored to 255 before the
			// filter, so alpha stays ~1 and the content survives. Without the
			// correction alpha would collapse to ~0.1.
			const alpha = layer.getImageData(4, 4, 1, 1).data[3]!;
			expect(alpha).toBeGreaterThan(230);
		} finally {
			svg.remove();
		}
	});

	it("does not luma-correct image-based masks (never-recolored pixels)", () => {
		// An image-based luminosity mask reaches the mask canvas via drawImage
		// and was never recolored — "un-mapping" it would invert its alpha.
		const svgNS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNS, "svg");
		svg.setAttribute("width", "0");
		svg.setAttribute("height", "0");
		const filter = document.createElementNS(svgNS, "filter");
		filter.setAttribute("id", "g_test_luminosity_map_1");
		filter.setAttribute("color-interpolation-filters", "sRGB");
		const matrix = document.createElementNS(svgNS, "feColorMatrix");
		matrix.setAttribute("type", "matrix");
		matrix.setAttribute(
			"values",
			"0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0.3 0.59 0.11 0 0",
		);
		filter.append(matrix);
		svg.append(filter);
		document.body.append(svg);

		try {
			const layer = makeCtx();
			applyContextRecolor(layer, testMap);
			layer.fillStyle = "#ff0000";
			layer.fillRect(0, 0, 8, 8);

			// White "image" mask drawn into a wrapped mask context via
			// drawImage only — pixels stay white, nothing was recolored.
			const image = makeCtx();
			image.fillStyle = "#ffffff";
			image.fillRect(0, 0, 8, 8);
			const mask = makeCtx();
			applyContextRecolor(mask, testMap);
			mask.drawImage(image.canvas, 0, 0);
			expect(pixel(mask)).toBe("#ffffff");

			layer.save();
			layer.filter = "url(#g_test_luminosity_map_1)";
			layer.globalCompositeOperation = "destination-in";
			layer.drawImage(mask.canvas, 0, 0);
			layer.restore();

			// Uncorrected white mask = luma 1 = fully visible. A wrongly
			// applied correction would collapse alpha to ~0 instead.
			const alpha = layer.getImageData(4, 4, 1, 1).data[3]!;
			expect(alpha).toBeGreaterThan(230);
		} finally {
			svg.remove();
		}
	});

	it("leaves ordinary drawImage compositing untouched", () => {
		const source = makeCtx();
		source.fillStyle = "#123456";
		source.fillRect(0, 0, 8, 8);

		const ctx = makeCtx();
		applyContextRecolor(ctx, testMap);
		ctx.fillStyle = "#ff0000";
		ctx.fillRect(0, 0, 8, 8);
		// destination-in without a luminosity filter must not be corrected.
		ctx.save();
		ctx.globalCompositeOperation = "destination-in";
		ctx.drawImage(source.canvas, 0, 0);
		ctx.restore();
		expect(pixel(ctx)).toBe("#ff0000");
	});

	it("maps the same color only once even when re-fed (background refill)", () => {
		// pdf.js fills the canvas with the `background` render param through
		// the wrapped fillRect; lector passes the ORIGINAL background, so a
		// single mapping must land on the dark color, not roundtrip back.
		const ctx = makeCtx();
		applyContextRecolor(ctx, (c) => (c === "#ffffff" ? DARK : c));
		const saved = ctx.fillStyle; // pdf.js beginDrawing saves
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, 8, 8);
		ctx.fillStyle = saved; // and restores
		expect(pixel(ctx)).toBe(DARK);
		expect(ctx.fillStyle).toBe(saved);
	});
});
