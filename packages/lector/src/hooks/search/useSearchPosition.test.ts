import { describe, expect, it } from "vitest";

import { calculateHighlightRects } from "./useSearchPosition";

// Safety invariant for the scroll-idle text-layer deferral: search/citation
// highlight rects are derived from the pdf.js text CONTENT (getTextContent +
// item transforms), never from the rendered .textLayer DOM. So deferring the
// text-layer build cannot break search highlighting — there is no DOM here at
// all and the rects still compute. If someone refactors search to read the
// rendered spans, this test fails alongside the defer.
describe("calculateHighlightRects (search ⊥ rendered text layer)", () => {
	const fakePageProxy = {
		getTextContent: async () => ({
			items: [
				{
					str: "hello world",
					transform: [1, 0, 0, 1, 10, 700],
					width: 110,
					height: 12,
				},
			],
		}),
		getViewport: () => ({ width: 600, height: 800 }),
	} as any;

	it("computes rects from text content with no text-layer DOM present", async () => {
		const rects = await calculateHighlightRects(fakePageProxy, {
			pageNumber: 3,
			text: "hello world",
			matchIndex: 6, // start of "world"
			searchText: "world",
		});

		expect(rects.length).toBeGreaterThan(0);
		const r = rects[0]!;
		expect(r.pageNumber).toBe(3);
		// "world" starts ~6/11 into the 110-wide item → left offset past the item origin.
		expect(r.left).toBeGreaterThan(10);
		expect(r.width).toBeGreaterThan(0);
		expect(Number.isFinite(r.top)).toBe(true);
		expect(r.height).toBe(12);
	});
});
