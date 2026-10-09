import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";

beforeAll(async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
});
afterEach(cleanup);

// 612x792 pages with the default 10px gap: page N starts at (N - 1) * 802.
const PAGE_PITCH = 802;

for (const progressive of [false, true]) {
	test(`${progressive ? "progressive" : "eager"} document opens at initialPage without a scroll to the top first`, async () => {
		let store!: ReturnType<typeof PDFStore.useContext>;
		function Probe() {
			store = PDFStore.useContext();
			return null;
		}
		// Record every scrollTop the viewport ever reports, from the first frame.
		const seen: number[] = [];
		let viewport: HTMLElement | null = null;
		let frame = 0;
		const sample = () => {
			viewport ??= document.querySelector('[data-testid="viewport"]');
			if (viewport && viewport.scrollHeight > viewport.clientHeight)
				seen.push(viewport.scrollTop);
			frame = requestAnimationFrame(sample);
		};
		frame = requestAnimationFrame(sample);

		render(
			<Root
				source={createTextPdf(20, 1)}
				progressive={progressive}
				initialPage={10}
				style={{ height: 500, width: 800 }}
			>
				<Probe />
				<Pages data-testid="viewport">
					<Page>
						<CanvasLayer />
					</Page>
				</Pages>
			</Root>,
		);
		try {
			await waitFor(
				() => expect(store?.getState().renderedPages[10]).toBe(true),
				{ timeout: 10_000 },
			);
			expect(viewport!.scrollTop).toBeCloseTo(9 * PAGE_PITCH, -1);
			expect(store.getState().currentPage).toBe(10);
			// The virtualizer must never have shown the top of the document.
			expect(seen.length).toBeGreaterThan(0);
			expect(Math.min(...seen)).toBeGreaterThan(8 * PAGE_PITCH);
		} finally {
			cancelAnimationFrame(frame);
		}
	}, 15000);
}
