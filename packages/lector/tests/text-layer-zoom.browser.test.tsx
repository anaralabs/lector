import "pdfjs-dist/web/pdf_viewer.css";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextGeometryPdf } from "./fixtures/text-geometry";

afterEach(cleanup);

/** Client-space box of the dark pixels on the page's base canvas. */
function inkBounds(canvas: HTMLCanvasElement) {
	const { data, width, height } = canvas
		.getContext("2d")!
		.getImageData(0, 0, canvas.width, canvas.height);
	let left = width,
		top = height,
		right = 0,
		bottom = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = (y * width + x) * 4;
			if (data[index]! < 128 && data[index + 3]! > 128) {
				left = Math.min(left, x);
				top = Math.min(top, y);
				right = Math.max(right, x + 1);
				bottom = Math.max(bottom, y + 1);
			}
		}
	}
	const box = canvas.getBoundingClientRect();
	const sx = box.width / width;
	const sy = box.height / height;
	return {
		left: box.left + left * sx,
		top: box.top + top * sy,
		right: box.left + right * sx,
		bottom: box.top + bottom * sy,
	};
}

// Selection and search geometry come from these spans. In WebKit, pages are
// laid out with CSS `zoom` and the text layer counters it (see TextLayer),
// because Safari sizes zoomed text wrongly (iOS ignores the zoom, macOS
// clamps to 9px). Playwright's WebKit does neither, so this can't reproduce
// the bug; it checks that the countered layer still lines up with the canvas.
for (const zoom of [0.5, 2]) {
	for (const rotation of [0, 90]) {
		test(`text layer spans cover their rendered glyphs at zoom ${zoom}, rotation ${rotation}`, async () => {
			const pdfjs = await loadPdfJs();
			pdfjs.GlobalWorkerOptions.workerSrc = new URL(
				"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
				import.meta.url,
			).href;
			let store: ReturnType<typeof PDFStore.useContext> | undefined;
			function Probe() {
				store = PDFStore.useContext();
				return null;
			}
			const view = render(
				<Root
					source={{ data: createTextGeometryPdf({ rotation }) }}
					zoom={zoom}
					zoomOptions={{ minZoom: 0.1, maxZoom: 4 }}
					style={{ height: 900, width: 900 }}
				>
					<Probe />
					<Pages>
						<Page>
							<CanvasLayer />
							<TextLayer />
						</Page>
					</Pages>
				</Root>,
			);
			await waitFor(
				() => expect(store?.getState().renderedPages[1]).toBe(true),
				{ timeout: 15000 },
			);
			const span = await waitFor(() => {
				const found = [
					...view.container.querySelectorAll(".textLayer span"),
				].find((element) => element.textContent === "READER");
				expect(found).toBeTruthy();
				return found!;
			});
			const range = document.createRange();
			range.selectNodeContents(span);
			const text = range.getBoundingClientRect();
			const ink = inkBounds(view.container.querySelector("canvas")!);
			expect(ink.right).toBeGreaterThan(ink.left);

			const slack = 1.5;
			expect(text.left).toBeLessThanOrEqual(ink.left + slack);
			expect(text.top).toBeLessThanOrEqual(ink.top + slack);
			expect(text.right).toBeGreaterThanOrEqual(ink.right - slack);
			expect(text.bottom).toBeGreaterThanOrEqual(ink.bottom - slack);
			// Text that kept its unzoomed size would cover 1/zoom² the ink's
			// area (4x at zoom 0.5).
			expect(text.width * text.height).toBeLessThan(
				(ink.right - ink.left) * (ink.bottom - ink.top) * 2.5,
			);
		}, 20000);
	}
}
