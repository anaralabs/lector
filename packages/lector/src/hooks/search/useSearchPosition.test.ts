import type { PDFPageProxy } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";
import { calculateHighlightRects } from "./useSearchPosition";

const item = (str: string, left: number) => ({
	str,
	transform: [1, 0, 0, 1, left, 700],
	width: str.length * 10,
	height: 12,
});

function pageWithChunks(chunks: ReturnType<typeof item>[][]) {
	const streamTextContent = vi.fn(
		() =>
			new ReadableStream({
				start(controller) {
					for (const items of chunks) controller.enqueue({ items });
					controller.close();
				},
			}),
	);
	const page = {
		streamTextContent,
		getTextContent: vi.fn(() => {
			throw new Error("shared getTextContent must not be used");
		}),
		getViewport: () => ({ width: 600, height: 800 }),
	};
	return { page: page as unknown as PDFPageProxy, streamTextContent };
}

describe("calculateHighlightRects", () => {
	it("computes a match spanning independently streamed chunks without text-layer DOM", async () => {
		const { page } = pageWithChunks([
			[item("hello ", 10)],
			[item("world", 70)],
		]);
		const rects = await calculateHighlightRects(page, {
			pageNumber: 3,
			text: "hello world",
			matchIndex: 4,
			searchText: "o world",
		});
		expect(rects).toEqual([
			{ pageNumber: 3, left: 50, top: 88, width: 70, height: 12 },
		]);
	});

	it("keeps concurrent searches independent", async () => {
		const { page, streamTextContent } = pageWithChunks([
			[item("hello world", 10)],
		]);
		const searches = await Promise.all(
			[0, 6].map((matchIndex) =>
				calculateHighlightRects(page, {
					pageNumber: 1,
					text: "hello world",
					matchIndex,
					searchText: "hello",
				}),
			),
		);
		expect(streamTextContent).toHaveBeenCalledTimes(2);
		expect(searches.map((rects) => rects[0]?.left)).toEqual([10, 70]);
	});
});

it("highlights the original Unicode match span rather than the normalized query length", async () => {
	const { page } = pageWithChunks([[item("İ!", 10)]]);
	const rects = await calculateHighlightRects(page, {
		pageNumber: 1,
		text: "İ!",
		matchIndex: 0,
		searchText: "i\u0307",
		matchLength: 1,
	});
	expect(rects[0]?.width).toBe(10);
});
