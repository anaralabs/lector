import { cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";

afterEach(cleanup);
for (const count of [10, 100, 1000]) {
	test(`measure real ${count}-page startup`, async () => {
		const pdfjs = await loadPdfJs();
		pdfjs.GlobalWorkerOptions.workerSrc = new URL(
			"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
			import.meta.url,
		).href;
		let store: ReturnType<typeof PDFStore.useContext> | undefined;
		let requests = 0,
			active = 0,
			peak = 0,
			loadedAt = 0;
		let firstReadyAt = 0;
		function Probe() {
			store = PDFStore.useContext();
			const pdfStore = store;
			useLayoutEffect(
				() =>
					pdfStore.subscribe((state) => {
						if (state.renderedPages[1] && firstReadyAt === 0)
							firstReadyAt = performance.now();
					}),
				[pdfStore],
			);
			return null;
		}
		const data = createTextPdf(count);
		const started = performance.now();
		const view = render(
			<Root
				source={data}
				style={{ height: 700, width: 800 }}
				onDocumentLoad={({ proxy }) => {
					loadedAt = performance.now();
					const getPage = proxy.getPage.bind(proxy);
					proxy.getPage = (page) => {
						requests++;
						peak = Math.max(peak, ++active);
						return getPage(page).finally(() => active--);
					};
				}}
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
		await waitFor(() => expect(store?.getState().renderedPages[1]).toBe(true), {
			timeout: 20000,
		});
		console.info(
			`AUDIT startup pages=${count}: firstPaintMs=${(firstReadyAt - started).toFixed(1)}, afterDocumentMs=${(firstReadyAt - loadedAt).toFixed(1)}, getPageCalls=${requests}, peakPageRequests=${peak}, DOM=${view.container.querySelectorAll("*").length}, canvases=${view.container.querySelectorAll("canvas").length}`,
		);
		expect(store!.getState().pdfDocumentProxy.numPages).toBe(count);
		expect(peak).toBeLessThanOrEqual(16);
		view.unmount();
	}, 25000);
}
