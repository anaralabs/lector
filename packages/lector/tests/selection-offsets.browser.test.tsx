import { afterEach, expect, test } from "vitest";
import { PDFSelectionController } from "../src/lib/pdf-selection";
import { SelectionPage } from "../src/lib/selection-page";

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	document.getSelection()?.removeAllRanges();
});

function fixture() {
	const element = document.createElement("div");
	element.style.width = "600px";
	const node = document.createTextNode("a".repeat(60));
	element.append(node);
	document.body.append(element);
	disposers.push(() => element.remove());
	return { element, node, page: new SelectionPage(element, 1, 600, 800) };
}

test("projection clamps a remembered offset 42 to the current 12-character node", () => {
	const { page, node } = fixture();
	node.data = "abcdefghijkl";
	const point = page.point(42)!;
	document.getSelection()!.setBaseAndExtent(node, 0, point.node, point.offset);
	expect(document.getSelection()!.toString()).toBe(node.data);
});

test("rectangles clamp a remembered end offset 47 to the current node length", () => {
	const { page, node } = fixture();
	node.data = "abcdefghijkl";
	expect(page.rects(0, 47).length).toBeGreaterThan(0);
	expect(page.rects(42, 47)).toEqual([]);
});

test.each([false, true])(
	"setSelection survives shortened text with backwards=%s",
	(backwards) => {
		const { element, node } = fixture();
		const controller = new PDFSelectionController({
			pageCount: 1,
			loadPage: async () => {
				throw new Error("Unexpected page load");
			},
		});
		disposers.push(controller.connect(element));
		disposers.push(controller.registerLayer(element, 1, 600, 800));
		node.data = "abcdefghijkl";
		const start = { pageNumber: 1, offset: 0 };
		const end = { pageNumber: 1, offset: 47 };
		controller.setSelection(backwards ? end : start, backwards ? start : end);
		expect(controller.getSnapshot()?.status).toBe("ready");
		expect(document.getSelection()!.toString()).toBe(node.data);
		expect(document.getSelection()!.anchorOffset).toBe(backwards ? 12 : 0);
	},
);

test("empty or detached text nodes cannot produce stale ranges", () => {
	const { page, node } = fixture();
	node.data = "";
	expect(page.point(42)?.offset).toBe(0);
	expect(page.rects(0, 47)).toEqual([]);
	node.remove();
	expect(page.point(42)).toBeNull();
	expect(page.rects(0, 47)).toEqual([]);
});

test("unchanged text keeps exact selection offsets and rectangle bounds", () => {
	const { page, node } = fixture();
	expect(page.point(42)).toEqual({ node, offset: 42 });
	const range = document.createRange();
	range.setStart(node, 42);
	range.setEnd(node, 47);
	const bounds = range.getBoundingClientRect();
	expect(page.rects(42, 47)[0]?.width).toBeCloseTo(bounds.width);
});
