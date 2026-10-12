import "pdfjs-dist/web/pdf_viewer.css";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { inkBounds } from "./fixtures/ink";
import { createTextGeometryPdf } from "./fixtures/text-geometry";

afterEach(cleanup);

// Chromium honours CSS `zoom` in client rects, so forcing the WebKit layout
// zoom path here runs the counter-zoomed text layer in every test browser.
vi.mock("../src/lib/zoom", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/zoom")>()),
	USE_LAYOUT_ZOOM: true,
}));

/** Client-space box of the dark pixels on the page's base canvas. */
function canvasInk(canvas: HTMLCanvasElement) {
	const ink = inkBounds(
		canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
			.data,
		canvas.width,
		canvas.height,
	);
	const box = canvas.getBoundingClientRect();
	const sx = box.width / canvas.width;
	const sy = box.height / canvas.height;
	return {
		left: box.left + ink.left * sx,
		top: box.top + ink.top * sy,
		right: box.left + ink.right * sx,
		bottom: box.top + ink.bottom * sy,
	};
}

// Selection and search geometry come from these spans. In WebKit, pages are
// laid out with CSS `zoom` and the text layer counters it (see TextLayer),
// because Safari sizes zoomed text wrongly (iOS ignores the zoom, macOS
// clamps to 9px). No Playwright browser does either, so this can't reproduce
// the Safari bug itself; it checks that the countered layer lines up with the
// canvas, before and after its text is built.
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
			// Before its text is built the layer must already cover exactly the
			// page: spans are placed by percent of this box as they stream in.
			const canvas = view.container.querySelector("canvas")!;
			const layer = view.container.querySelector(".textLayer")!;
			// Test browsers zoom text correctly either way, so pin the counter
			// itself: its absence is only visible in Safari.
			const counter = getComputedStyle(layer);
			expect(Number(counter.zoom)).toBeCloseTo(1 / zoom);
			expect(Number(counter.scale)).toBeCloseTo(zoom);
			// Compare boxes unsorted: an unrotated layer on a rotated page has the
			// same dimensions swapped, and overhangs it.
			const expectLayerOnPage = () => {
				const layerBox = layer.getBoundingClientRect();
				const pageBox = canvas.getBoundingClientRect();
				for (const key of ["left", "top", "width", "height"] as const) {
					expect(layerBox[key]).toBeCloseTo(pageBox[key], 0);
				}
			};
			expectLayerOnPage();
			const span = await waitFor(() => {
				const found = [
					...view.container.querySelectorAll(".textLayer span"),
				].find((element) => element.textContent === "READER");
				expect(found).toBeTruthy();
				return found!;
			});
			expectLayerOnPage();
			const range = document.createRange();
			range.selectNodeContents(span);
			const text = range.getBoundingClientRect();
			const ink = canvasInk(canvas);
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
