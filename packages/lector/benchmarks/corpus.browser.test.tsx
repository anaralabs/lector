import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";

afterEach(cleanup);
const documents = ["brochure", "large", "expensive", "2506.13188v1"];
const repeats = Math.max(1, 3);
for (let run = 1; run <= repeats; run++)
	for (const name of documents)
		for (const colorScheme of ["light", "dark"] as const) {
			test(`run ${run}: ${name}, ${colorScheme}: real first paint, scrolling and backing pixels`, async () => {
				const pdfjs = await loadPdfJs();
				pdfjs.GlobalWorkerOptions.workerSrc = new URL(
					"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
					import.meta.url,
				).href;
				let store: ReturnType<typeof PDFStore.useContext> | undefined;
				let loaded = 0;
				const errors: unknown[] = [];
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
				const begin = performance.now();
				const view = render(
					<Root
						source={
							new URL(`../../docs/public/pdf/${name}.pdf`, import.meta.url).href
						}
						colorScheme={colorScheme}
						onDocumentLoad={() => {
							loaded = performance.now();
						}}
						onError={(error) => errors.push(error)}
						style={{ height: 700, width: 800 }}
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
					{ timeout: 45000 },
				);
				const firstPaintMs = firstReadyAt - begin;
				const afterDocumentMs = firstReadyAt - loaded;
				const count = store!.getState().pdfDocumentProxy.numPages;
				const container = store!.getState().viewportRef.current!;
				const frames: number[] = [];
				let previous = performance.now();
				const maxOffset = container.scrollHeight - container.clientHeight;
				for (let i = 1; i <= 45; i++) {
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => {
							const now = performance.now();
							frames.push(now - previous);
							previous = now;
							container.scrollTop = (maxOffset * i) / 45;
							resolve();
						}),
					);
				}
				await waitFor(
					() => expect(store!.getState().renderedPages[count]).toBe(true),
					{ timeout: 45000 },
				);
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 300));
				});
				frames.sort((a, b) => a - b);
				const canvases = Array.from(view.container.querySelectorAll("canvas"));
				console.info(
					`CORPUS ${JSON.stringify({ run, name, colorScheme, pages: count, firstPaintMs: +firstPaintMs.toFixed(1), afterDocumentMs: +afterDocumentMs.toFixed(1), scrollFrameP95Ms: +frames[Math.floor(frames.length * 0.95)]!.toFixed(1), framesOver32ms: frames.filter((x) => x > 32).length, canvasCount: canvases.length, visibleCanvasBytes: canvases.reduce((sum, c) => sum + c.width * c.height * 4, 0), dom: view.container.querySelectorAll("*").length })}`,
				);
				expect(errors).toEqual([]);
				expect(canvases.length).toBeLessThanOrEqual(12);
				view.unmount();
				expect(canvases.every((canvas) => canvas.width <= 1)).toBe(true);
			});
		}
