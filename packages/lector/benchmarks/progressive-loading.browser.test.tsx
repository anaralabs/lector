import { cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeAll, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "../tests/fixtures/pdf";

beforeAll(async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
});
afterEach(cleanup);

for (const corpus of ["generated-1000", "large-320"] as const) {
	for (const metadataDelayMs of [0, 10]) {
		test(`${corpus}, page acquisition delay ${metadataDelayMs} ms`, async () => {
			const samples: Record<string, unknown>[] = [];
			for (let run = 0; run < 6; run++) {
				for (const progressive of run % 2 ? [true, false] : [false, true]) {
					let store: ReturnType<typeof PDFStore.useContext> | undefined;
					let documentAt = 0,
						readyAt = 0,
						resolved = 0,
						resolvedAtReady = 0,
						peak = 0,
						active = 0;
					function Probe() {
						store = PDFStore.useContext();
						const current = store;
						useLayoutEffect(
							() =>
								current.subscribe((state) => {
									if (!readyAt && state.renderedPages[1]) {
										readyAt = performance.now();
										resolvedAtReady = resolved;
									}
								}),
							[current],
						);
						return null;
					}
					const source =
						corpus === "generated-1000"
							? createTextPdf(1000, 1)
							: new URL("../../docs/public/pdf/large.pdf", import.meta.url)
									.href;
					const begin = performance.now();
					const view = render(
						<Root
							source={source}
							progressive={progressive}
							style={{ height: 700, width: 800 }}
							onDocumentLoad={({ proxy }) => {
								documentAt = performance.now();
								const getPage = proxy.getPage.bind(proxy);
								proxy.getPage = async (number) => {
									peak = Math.max(peak, ++active);
									try {
										if (metadataDelayMs)
											await new Promise((resolve) =>
												setTimeout(resolve, metadataDelayMs),
											);
										const page = await getPage(number);
										resolved++;
										return page;
									} finally {
										active--;
									}
								};
							}}
						>
							<Probe />
							<Pages>
								<Page>
									<CanvasLayer />
								</Page>
							</Pages>
						</Root>,
					);
					await waitFor(() => expect(readyAt).toBeGreaterThan(0), {
						timeout: 15000,
					});
					await waitFor(
						() => expect(store?.getState().pagesLoaded).toBe(true),
						{ timeout: 15000 },
					);
					expect(peak).toBeLessThanOrEqual(16);
					if (run > 0)
						samples.push({
							run,
							progressive,
							firstCanvasMs: +(readyAt - begin).toFixed(2),
							afterDocumentMs: +(readyAt - documentAt).toFixed(2),
							resolvedAtFirstCanvas: resolvedAtReady,
							peakRequests: peak,
						});
					view.unmount();
				}
			}
			console.info(
				`PROGRESSIVE_RESULT ${JSON.stringify({ corpus, metadataDelayMs, warmupPairs: 1, samples })}`,
			);
		}, 60000);
	}
}
