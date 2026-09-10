import "pdfjs-dist/web/pdf_viewer.css";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { bindMouseEvents } from "../src/hooks/layers/useTextLayer";
import { useSelectionDimensions } from "../src/hooks/useSelectionDimensions";
import { wrapperFor } from "./helpers";

const layers: (HTMLDivElement & { _cleanupTextSelection?: () => void })[] = [];
afterEach(() => {
	cleanup();
	document.getSelection()?.removeAllRanges();
	for (const layer of layers.splice(0)) {
		layer._cleanupTextSelection?.();
		layer.remove();
	}
	document.querySelectorAll("style[data-test]").forEach((el) => {
		el.remove();
	});
});

function isPointInFill(path: SVGPathElement, x: number, y: number) {
	// Chromium 131 (pinned by Playwright) requires SVGPoint rather than DOMPoint.
	const point = path.ownerSVGElement!.createSVGPoint();
	point.x = x;
	point.y = y;
	return path.isPointInFill(point);
}

function fixture() {
	const style = document.createElement("style");
	style.dataset.test = "";
	style.textContent = `.textLayer span { position: absolute; font: 40px/1 Times; white-space: pre; color: transparent; }
 .textLayer span::selection { background: rgba(0, 100, 255, 0.3); }`;
	document.head.append(style);
	const layer = document.createElement("div");
	layer.className = "textLayer";
	layer.style.cssText = "position:relative;width:600px;height:200px";
	layer.innerHTML = `<span style="font-size:40px;left:10px;top:20px">alignment model</span><span style="font-size:40px;left:250px;top:19px;font-style:italic">a</span><span style="font-size:40px;left:268px;top:20px"> as a network</span>`;
	const end = document.createElement("div");
	end.className = "endOfContent";
	layer.append(end);
	document.body.append(layer);
	layers.push(layer);
	bindMouseEvents(layer, end);
	return layer;
}

function select(layer: HTMLElement) {
	const spans = layer.querySelectorAll("span");
	const range = document.createRange();
	range.setStart(spans[0]!.firstChild!, 0);
	range.setEnd(spans[2]!.firstChild!, spans[2]!.textContent!.length);
	const selection = document.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
}

test("paints a single selection background across overlapping math text runs", async () => {
	const layer = fixture();
	select(layer);
	// Sample the painted background, including the overlapping math spans.
	const screenshot = await page.screenshot({ base64: true });
	const image = new Image();
	image.src = `data:image/png;base64,${screenshot.base64}`;
	await image.decode();
	const canvas = document.createElement("canvas");
	canvas.width = image.width;
	canvas.height = image.height;
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(image, 0, 0);
	const bounds = layer.getBoundingClientRect();
	const pixel = (x: number) =>
		Array.from(ctx.getImageData(bounds.left + x, bounds.top + 30, 1, 1).data);
	expect(pixel(20)).toEqual([178, 208, 255, 255]);
	expect(pixel(250)).toEqual(pixel(20));
	expect(pixel(268)).toEqual(pixel(20));
	const overlay = layer.querySelector("svg[data-lector-selection]");
	expect(overlay).not.toBeNull();
	expect(overlay!.querySelectorAll("path")).toHaveLength(1);
	expect(
		overlay!.querySelector("path")!.getAttribute("d")!.match(/M/g),
	).toHaveLength(1);
	expect(
		getComputedStyle(layer.querySelector("span")!, "::selection")
			.backgroundColor,
	).toBe("rgba(0, 0, 0, 0)");
	expect(document.getSelection()!.toString()).toBe(
		"alignment modela as a network",
	);
});

test("keeps separate lines and columns separate", () => {
	const layer = fixture();
	const spans = layer.querySelectorAll("span");
	spans[1]!.style.top = "90px";
	spans[1]!.style.left = "10px";
	spans[2]!.style.left = "420px";
	select(layer);
	expect(
		layer.querySelector("path")!.getAttribute("d")!.match(/M/g),
	).toHaveLength(3);
});

test("uses page-local coordinates at fractional zoom", () => {
	const layer = fixture();
	select(layer);
	const initial = layer
		.querySelector("path")!
		.getAttribute("d")!
		.match(/-?[\d.]+/g)!
		.map(Number);
	layer.style.transformOrigin = "0 0";
	layer.style.transform = "translate(35px, 10px) scale(1.75)";
	select(layer);
	const zoomed = layer
		.querySelector("path")!
		.getAttribute("d")!
		.match(/-?[\d.]+/g)!
		.map(Number);
	expect(zoomed).toHaveLength(initial.length);
	zoomed.forEach((value, i) => {
		expect(value).toBeCloseTo(initial[i]!, 1);
	});
});

test("clears the background when selection collapses", () => {
	const layer = fixture();
	select(layer);
	document.getSelection()!.collapseToEnd();
	document.dispatchEvent(new Event("selectionchange"));
	expect(layer.querySelector("svg")).toBeNull();
	expect(layer.hasAttribute("data-lector-selection-active")).toBe(false);
});

test("respects transparent native backgrounds used by CustomSelection", () => {
	const layer = fixture();
	const style = document.querySelector<HTMLStyleElement>("style[data-test]")!;
	style.textContent +=
		".textLayer span::selection { background: transparent; }";
	select(layer);
	expect(layer.querySelector("svg")).toBeNull();
	expect(layer.hasAttribute("data-lector-selection-active")).toBe(false);
});

test("updates the color when the reader theme changes", () => {
	const layer = fixture();
	select(layer);
	const style = document.querySelector<HTMLStyleElement>("style[data-test]")!;
	style.textContent +=
		".textLayer span::selection { background: rgba(255, 100, 0, 0.4); }";
	select(layer);
	expect(layer.querySelector("path")!.getAttribute("fill")).toBe(
		"rgba(255, 100, 0, 0.4)",
	);
});

test("paints each selected page and cleans up unmounted layers", () => {
	const first = fixture();
	const second = fixture();
	const range = document.createRange();
	range.setStart(first.querySelector("span")!.firstChild!, 3);
	range.setEnd(second.querySelectorAll("span")[2]!.firstChild!, 4);
	document.getSelection()!.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
	expect(first.querySelector("path")).not.toBeNull();
	expect(second.querySelector("path")).not.toBeNull();
	layers[0]!._cleanupTextSelection!();
	expect(first.querySelector("svg")).toBeNull();
	expect(first.hasAttribute("data-lector-selection-active")).toBe(false);
	expect(second.querySelector("path")).not.toBeNull();
});

test("merges subscript and reordered text runs into the same line", () => {
	const layer = fixture();
	const spans = layer.querySelectorAll("span");
	spans[1]!.style.fontSize = "22px";
	spans[1]!.style.top = "40px";
	layer.insertBefore(spans[2]!, spans[0]!);
	select(layer);
	expect(
		layer.querySelector("path")!.getAttribute("d")!.match(/M/g),
	).toHaveLength(1);
});

test.each([1, 1.75, 3])(
	"fills word and sentence spacing between selected runs at %sx zoom",
	(zoom) => {
		const layer = fixture();
		const spans = layer.querySelectorAll("span");
		spans[0]!.textContent = "(z₁, …, zₙ).";
		spans[1]!.textContent = "Given z,";
		spans[2]!.textContent = "the decoder";
		const gaps: number[] = [];
		for (let i = 1; i < spans.length; i++) {
			const previous = spans[i - 1]!;
			const right =
				previous.offsetLeft + previous.getBoundingClientRect().width;
			// PDF spacing is often represented by positioning, with no space glyph.
			spans[i]!.style.left = `${right + 18}px`;
			gaps.push(right + 9);
		}
		layer.style.transformOrigin = "0 0";
		layer.style.transform = `scale(${zoom})`;
		select(layer);
		const path = layer.querySelector("path")!;
		for (const x of gaps) {
			expect(isPointInFill(path, x, 40)).toBe(true);
		}
		expect(path.getAttribute("d")!.match(/M/g)).toHaveLength(1);
	},
);

test("leaves a column gutter unpainted even when text shares a baseline", () => {
	const layer = fixture();
	const spans = layer.querySelectorAll("span");
	const right = spans[0]!.offsetLeft + spans[0]!.getBoundingClientRect().width;
	spans[1]!.style.left = `${right + 40}px`;
	spans[2]!.style.left = `${right + 60}px`;
	select(layer);
	const path = layer.querySelector("path")!;
	expect(isPointInFill(path, right + 20, 40)).toBe(false);
	expect(path.getAttribute("d")!.match(/M/g)).toHaveLength(2);
});

test.each(["getDimension", "getSelection", "getAnnotationDimension"] as const)(
	"preserves partial first and last lines when saving with %s",
	(method) => {
		const layer = fixture();
		const spans = layer.querySelectorAll("span");
		for (let i = 0; i < spans.length; i++) {
			spans[i]!.style.left = "10px";
			spans[i]!.style.top = `${20 + i * 40}px`;
			spans[i]!.textContent = "Most competitive neural models";
		}
		const range = document.createRange();
		range.setStart(spans[0]!.firstChild!, 4);
		range.setEnd(spans[2]!.firstChild!, 4);
		document.getSelection()!.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		const selectedText = document.getSelection()!.toString().trim();
		const { result } = renderHook(useSelectionDimensions, {
			wrapper: wrapperFor(),
		});
		const saved = result.current[method]()!;
		const path = layer.querySelector("path")!;
		const contains = (x: number, y: number) =>
			saved.highlights.some(
				(rect) =>
					x > rect.left &&
					x < rect.left + rect.width &&
					y > rect.top &&
					y < rect.top + rect.height,
			);
		// Neither the unselected prefix nor the rest of the final line may be painted.
		for (const [x, y] of [
			[12, 40],
			[200, 120],
		]) {
			expect(isPointInFill(path, x!, y!)).toBe(false);
			expect(contains(x!, y!)).toBe(false);
		}
		expect(contains(200, 80)).toBe(true);
		expect(saved.highlights).toHaveLength(3);
		expect(saved.text).toBe(selectedText);
	},
);
