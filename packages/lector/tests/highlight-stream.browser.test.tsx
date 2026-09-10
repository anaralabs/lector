import type { PDFPageProxy } from "pdfjs-dist";
import { expect, test, vi } from "vitest";
import { calculateHighlightRects } from "../src/hooks/search/useSearchPosition";
import { acquireDocumentText } from "../src/lib/document-text";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";

test("stop reading once the highlight has been found, including marked/empty text", async () => {
	let reads = 0;
	const cancel = vi.fn();
	const page = {
		getViewport: () => ({ width: 600, height: 800 }),
		streamTextContent: () =>
			new ReadableStream(
				{
					pull(controller) {
						if (++reads > 1000) {
							controller.close();
							return;
						}
						controller.enqueue({
							items: [
								{ type: "beginMarkedContent" },
								{ str: "", transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0 },
								{
									str: "hello world",
									transform: [1, 0, 0, 1, 10, 700],
									width: 110,
									height: 12,
								},
							],
						});
					},
					cancel,
				},
				{ highWaterMark: 0 },
			),
	} as unknown as PDFPageProxy;
	const rects = await calculateHighlightRects(page, {
		pageNumber: 1,
		text: "hello",
		searchText: "hello",
		matchIndex: 0,
	});
	console.info(`AUDIT first-highlight-1000-chunks: streamReads=${reads}`);
	expect(rects).toEqual([
		{ pageNumber: 1, left: 10, top: 88, width: 50, height: 12 },
	]);
	expect(reads).toBe(1);
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
});

test("measure first highlight in a real PDF containing 10,000 text lines", async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	const task = pdfjs.getDocument({ data: createTextPdf(1, 10000) });
	const pdf = await task.promise;
	try {
		const page = await pdf.getPage(1);
		const started = performance.now();
		const rects = await calculateHighlightRects(page, {
			pageNumber: 1,
			text: "Page",
			searchText: "Page",
			matchIndex: 0,
		});
		expect(rects.length).toBeGreaterThan(0);
		console.info(
			`AUDIT real-first-highlight-10000-lines: ms=${(performance.now() - started).toFixed(1)}`,
		);
		// Let queued worker chunks arrive after cancellation, then prove another
		// consumer can still extract the full text from the same page.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const extraction = acquireDocumentText([page]);
		try {
			const fullText = await extraction.promise;
			expect(fullText[0]?.text).toContain("Page 1 line 10000:");
			expect(fullText[0]?.text.match(/Page 1 line /g)).toHaveLength(10000);
		} finally {
			extraction.release();
		}
	} finally {
		await task.destroy();
	}
}, 20000);
