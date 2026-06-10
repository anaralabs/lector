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
