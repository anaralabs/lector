import { afterEach, describe, expect, test } from "vitest";
import { SelectionPage } from "../src/lib/selection-page";

// A text layer shaped like a PDF page: absolutely positioned word spans, one
// <br> per line. Dense pages (an OCR'd scan) reach thousands of these.
const buildLayer = (lines: number, wordsPerLine: number) => {
	const layer = document.createElement("div");
	layer.className = "textLayer";
	layer.style.cssText =
		"position:absolute;left:0;top:0;width:600px;height:800px;font-size:12px;line-height:1";
	for (let line = 0; line < lines; line++) {
		let left = 20;
		for (let word = 0; word < wordsPerLine; word++) {
			const span = document.createElement("span");
			span.textContent = `w${line}-${word}`;
			span.style.cssText = `position:absolute;left:${left}px;top:${20 + line * 16}px;white-space:pre`;
			layer.append(span);
			left += 60;
		}
		layer.append(document.createElement("br"));
	}
	document.body.append(layer);
	return layer;
};

const layers: HTMLElement[] = [];
const page = (lines = 24, wordsPerLine = 8) => {
	const layer = buildLayer(lines, wordsPerLine);
	layers.push(layer);
	return new SelectionPage(layer, 1, 600, 800);
};

afterEach(() => {
	for (const layer of layers.splice(0)) layer.remove();
});

// The scans these replaced: a linear find by node, a linear scan for an offset,
// and a pass over every node on the page.
const findByNode = (selection: SelectionPage, node: Node) =>
	selection.nodes.find((item) => item.node === node);
const findByOffset = (selection: SelectionPage, index: number, end: boolean) =>
	selection.nodes.find((item) =>
		end ? item.end >= index : item.end > index,
	) ?? selection.nodes.at(-1);

const random = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
};

describe("SelectionPage lookups", () => {
	test("offset() resolves every node to the same place a scan would", () => {
		const selection = page();
		expect(selection.nodes.length).toBe(24 * 8);
		for (const item of selection.nodes) {
			const scanned = findByNode(selection, item.node);
			expect(scanned).toBe(item);
			for (const within of [0, 1, item.node.length, item.node.length + 5])
				expect(selection.offset(item.node, within)).toBe(
					item.start + Math.max(0, Math.min(within, item.end - item.start)),
				);
		}
	});

	test("offset() still falls back for a node outside the index", () => {
		const selection = page(2, 2);
		const stray = document.createTextNode("not indexed");
		selection.element.append(stray);
		expect(selection.offset(stray, 3)).toBe(selection.content.text.length);
		expect(
			selection.offset(document.createTextNode("elsewhere"), 0),
		).toBeNull();
	});

	test("point() matches the linear scan across the whole page", () => {
		const selection = page();
		const length = selection.content.text.length;
		for (let index = -4; index <= length + 4; index++) {
			for (const end of [false, true]) {
				const expected = findByOffset(
					selection,
					Math.max(0, Math.min(index, length)),
					end,
				);
				const actual = selection.point(index, end);
				expect(actual?.node).toBe(expected?.node);
			}
		}
	});

	test("rects() matches a full pass over the page for random ranges", () => {
		const selection = page();
		const length = selection.content.text.length;
		const next = random(99);
		for (let i = 0; i < 300; i++) {
			const a = Math.floor(next() * (length + 10)) - 5;
			const b = Math.floor(next() * (length + 10)) - 5;
			const from = Math.min(a, b);
			const to = Math.max(a, b);
			expect(selection.rects(from, to), `range ${from}..${to}`).toEqual(
				referenceRects(selection, from, to),
			);
		}
	});

	test("rects() covers the whole page and an empty range", () => {
		const selection = page();
		const all = selection.rects(0, selection.content.text.length);
		expect(all.length).toBeGreaterThan(100);
		expect(all).toEqual(
			referenceRects(selection, 0, selection.content.text.length),
		);
		expect(selection.rects(10, 10)).toEqual([]);
	});
});

/** rects() before the binary search: visit every node, skip by comparison. */
const referenceRects = (selection: SelectionPage, from: number, to: number) => {
	const bounds = selection.element.getBoundingClientRect();
	const scaleX = bounds.width / selection.width || 1;
	const scaleY = bounds.height / selection.height || 1;
	const rects = [];
	for (const item of selection.nodes) {
		if (!selection.element.contains(item.node)) continue;
		const start = Math.max(0, from - item.start);
		const end = Math.min(
			to - item.start,
			item.end - item.start,
			item.node.length,
		);
		if (end <= start || !item.node.data.slice(start, end).trim()) continue;
		const range = selection.element.ownerDocument.createRange();
		range.setStart(item.node, start);
		range.setEnd(item.node, end);
		for (const rect of range.getClientRects()) {
			if (rect.width <= 0 || rect.height <= 0) continue;
			rects.push({
				pageNumber: selection.pageNumber,
				left: (rect.left - bounds.left) / scaleX,
				top: (rect.top - bounds.top) / scaleY,
				width: rect.width / scaleX,
				height: rect.height / scaleY,
			});
		}
	}
	return rects;
};
