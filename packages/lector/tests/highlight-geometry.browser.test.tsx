import type { PDFPageProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { expect, test } from "vitest";
import { calculateHighlightRects } from "../src/hooks/search/useSearchPosition";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextGeometryPdf } from "./fixtures/text-geometry";

async function readTextItems(page: PDFPageProxy) {
	const reader = page.streamTextContent().getReader();
	const items: TextContent["items"] = [];
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return items;
			items.push(...value.items);
		}
	} finally {
		reader.releaseLock();
	}
}

for (const rotation of [0, 90, 180, 270]) {
	for (const crop of [false, true]) {
		test(`search highlight contains rendered glyphs: rotation ${rotation}, cropped ${crop}`, async () => {
			const pdfjs = await loadPdfJs();
			pdfjs.GlobalWorkerOptions.workerSrc = new URL(
				"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
				import.meta.url,
			).href;
			const task = pdfjs.getDocument({
				data: createTextGeometryPdf({ rotation, crop }),
			});
			try {
				const pdf = await task.promise;
				const page = await pdf.getPage(1);
				const viewport = page.getViewport({ scale: 1 });
				const canvas = document.createElement("canvas");
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				const context = canvas.getContext("2d")!;
				await page.render({ canvasContext: context, canvas, viewport }).promise;
				const pixels = context.getImageData(
					0,
					0,
					canvas.width,
					canvas.height,
				).data;
				let left = canvas.width,
					top = canvas.height,
					right = 0,
					bottom = 0;
				for (let y = 0; y < canvas.height; y++) {
					for (let x = 0; x < canvas.width; x++) {
						const index = (y * canvas.width + x) * 4;
						if (pixels[index]! < 128 && pixels[index + 3]! > 128) {
							left = Math.min(left, x);
							top = Math.min(top, y);
							right = Math.max(right, x + 1);
							bottom = Math.max(bottom, y + 1);
						}
					}
				}
				expect(right).toBeGreaterThan(left);
				const rects = await calculateHighlightRects(page, {
					pageNumber: 1,
					text: "READER",
					matchIndex: 0,
				});
				expect(rects).toHaveLength(1);
				const rect = rects[0]!;
				// Compare to the actual PDF.js raster, independently of extraction transforms.
				expect(rect.left).toBeLessThanOrEqual(left + 1);
				expect(rect.top).toBeLessThanOrEqual(top + 1);
				expect(rect.left + rect.width).toBeGreaterThanOrEqual(right - 1);
				expect(rect.top + rect.height).toBeGreaterThanOrEqual(bottom - 1);
				expect(rect.width * rect.height).toBeLessThan(
					(right - left) * (bottom - top) * 2,
				);
			} finally {
				await task.destroy();
			}
		});
	}
}

test("a search spanning separate PDF columns does not paint the gutter", async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	const task = pdfjs.getDocument({
		data: createTextGeometryPdf({
			operators:
				"BT /F1 20 Tf 1 0 0 1 100 500 Tm (LEFT) Tj 1 0 0 1 400 500 Tm (RIGHT) Tj ET",
		}),
	});
	try {
		const page = await (await task.promise).getPage(1);
		const text = (await readTextItems(page))
			.map((item) => ("str" in item ? item.str : ""))
			.join("");
		const rects = await calculateHighlightRects(page, {
			pageNumber: 1,
			text,
			matchIndex: 0,
		});
		expect(rects.length).toBeGreaterThanOrEqual(2);
		expect(
			rects.some((rect) => rect.left < 250 && rect.left + rect.width > 250),
		).toBe(false);
	} finally {
		await task.destroy();
	}
});

test.each([false, true])(
	"partial matches follow PDF.js fallback fonts (override: %s)",
	async (override) => {
		const pdfjs = await loadPdfJs();
		pdfjs.GlobalWorkerOptions.workerSrc = new URL(
			"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
			import.meta.url,
		).href;
		const fontMap = pdfjs.TextLayer.fontFamilyMap as Map<string, string>;
		const previousFamily = fontMap.get("sans-serif");
		if (override) fontMap.set("sans-serif", "monospace");
		const tasks = ["iiiiWWWW", "iiii"].map((text) =>
			pdfjs.getDocument({
				data: createTextGeometryPdf({
					operators: `BT /F1 20 Tf 1 0 0 1 100 500 Tm (${text}) Tj ET`,
				}),
			}),
		);
		const stylesheet = document.createElement("link");
		stylesheet.rel = "stylesheet";
		stylesheet.href = new URL(
			"../node_modules/pdfjs-dist/web/pdf_viewer.css",
			import.meta.url,
		).href;
		const container = document.createElement("div");
		container.className = "textLayer";
		container.style.position = "relative";
		container.style.setProperty("--scale-factor", "1");
		container.style.setProperty("--total-scale-factor", "1");
		try {
			await new Promise<void>((resolve, reject) => {
				stylesheet.onload = () => resolve();
				stylesheet.onerror = () =>
					reject(new Error("PDF.js text-layer stylesheet failed to load"));
				document.head.append(stylesheet);
			});
			document.body.append(container);
			const [page, reference] = await Promise.all(
				tasks.map(async (task) => (await task.promise).getPage(1)),
			);
			const expected = (await readTextItems(reference!)).find(
				(item) => "str" in item && item.str === "iiii",
			);
			if (!expected || !("width" in expected))
				throw new Error("Missing reference glyphs");
			const layer = new pdfjs.TextLayer({
				container,
				viewport: page!.getViewport({ scale: 1 }),
				textContentSource: page!.streamTextContent(),
			});
			await layer.render();
			const span = [...container.querySelectorAll("span")].find(
				(element) => element.textContent === "iiiiWWWW",
			);
			if (!span?.firstChild) throw new Error("Missing selectable text");
			const range = document.createRange();
			range.setStart(span.firstChild, 0);
			range.setEnd(span.firstChild, 4);
			const selectionWidth = range.getBoundingClientRect().width;
			expect(selectionWidth).toBeGreaterThan(0);
			const rects = await calculateHighlightRects(page!, {
				pageNumber: 1,
				text: "iiii",
				matchIndex: 0,
			});
			expect(rects[0]!.left).toBeCloseTo(100, 1);
			// Compare with real browser selection geometry, not a second copy of
			// measureText. PDF.js uses platform fallback fonts for selectable text;
			// their advances need not equal the PDF's native Helvetica metrics.
			const textLayerError = Math.abs(rects[0]!.width - selectionWidth);
			expect(textLayerError).toBeLessThan(1);
			const equalCharacterWidth = span.getBoundingClientRect().width / 2;
			if (!override)
				expect(Math.abs(equalCharacterWidth - selectionWidth)).toBeGreaterThan(
					20,
				);
			console.info(
				`FIDELITY proportional-width ${JSON.stringify({
					textLayerError,
					nativeHelveticaError: Math.abs(rects[0]!.width - expected.width),
					fontFamily: getComputedStyle(span).fontFamily,
				})}`,
			);
		} finally {
			if (previousFamily === undefined) fontMap.delete("sans-serif");
			else fontMap.set("sans-serif", previousFamily);
			container.remove();
			stylesheet.remove();
			await Promise.all(tasks.map((task) => task.destroy()));
		}
	},
);
