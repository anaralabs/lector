import { act, cleanup, render, waitFor } from "@testing-library/react";
import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	PDFPageProxy,
} from "pdfjs-dist";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { usePDFPageNumber } from "../src/hooks/usePdfPageNumber";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";

let task: PDFDocumentLoadingTask;
let pdf: PDFDocumentProxy;
let pages: PDFPageProxy[];
beforeAll(async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	task = pdfjs.getDocument({ data: createTextPdf(12, 1) });
	pdf = await task.promise;
	pages = await Promise.all(
		Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)),
	);
});
afterEach(cleanup);
afterAll(async () => task?.destroy());

function PageNumber() {
	const page = usePDFPageNumber();
	return (
		<div data-page={page} style={{ position: "absolute", inset: 0 }}>
			{page}
		</div>
	);
}

for (const initialZoom of [0.25, 0.5, 1, 2]) {
	test(`mounts every visible PDF page at zoom ${initialZoom}, including after scrolling and zoom changes`, async () => {
		let store!: ReturnType<typeof PDFStore.useContext>;
		function Probe() {
			store = PDFStore.useContext();
			return null;
		}
		const view = render(
			<PDFStore.Provider
				initialValue={{
					pdfDocumentProxy: pdf,
					pageProxies: pages,
					viewports: pages.map((page) => page.getViewport({ scale: 1 })),
					zoom: initialZoom,
					zoomOptions: { minZoom: 0.1, maxZoom: 4 },
				}}
			>
				<Probe />
				<Pages style={{ width: 650, height: 650 }}>
					<Page>
						<PageNumber />
					</Page>
				</Pages>
			</PDFStore.Provider>,
		);
		const verifyCoverage = async () => {
			await waitFor(() => {
				const state = store.getState();
				const viewport = state.viewportRef.current!;
				expect(viewport).toBeTruthy();
				const logicalTop = viewport.scrollTop / state.zoom;
				const logicalBottom = logicalTop + viewport.clientHeight / state.zoom;
				const expected = pages
					.map((_, index) => index)
					.filter(
						(index) =>
							index * 802 < logicalBottom && index * 802 + 792 > logicalTop,
					)
					.map((index) => index + 1);
				const mounted = [...view.container.querySelectorAll("[data-page]")].map(
					(element) => Number(element.getAttribute("data-page")),
				);
				expect(mounted).toEqual(expect.arrayContaining(expected));
				// Keep virtualization bounded as zoom changes in either direction.
				expect(mounted.length).toBeLessThanOrEqual(expected.length + 2);
			});
		};
		await verifyCoverage();
		act(() => {
			store.getState().viewportRef.current!.scrollTop = 650;
		});
		await waitFor(() =>
			expect(store.getState().virtualizer?.scrollOffset).toBeGreaterThan(0),
		);
		await verifyCoverage();
		act(() => store.getState().updateZoom(initialZoom === 0.25 ? 2 : 0.25));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 250));
		});
		await verifyCoverage();
	});
}
