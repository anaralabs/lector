import { act, cleanup, render, waitFor } from "@testing-library/react";
import { cdp } from "@vitest/browser/context";
import { afterEach, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { IS_MOBILE_DEVICE } from "../src/lib/canvas-utils";
import { loadPdfJs } from "../src/lib/pdfjs";

declare const __LECTOR_SOAK_CYCLES__: number;
declare const __LECTOR_SOAK_CPU_RATE__: number;
afterEach(cleanup);
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 350));

// Longer runs are opt-in; this is deliberately separate from fast CI tests.
test("real PDF scroll/zoom cycles release bitmaps and canvas allocations after each document", async () => {
	const protocol = cdp();
	const originalCreate = window.createImageBitmap;
	const originalClose = ImageBitmap.prototype.close;
	try {
		await protocol.send("Emulation.setCPUThrottlingRate", {
			rate: __LECTOR_SOAK_CPU_RATE__,
		});
		const pdfjs = await loadPdfJs();
		pdfjs.GlobalWorkerOptions.workerSrc = new URL(
			"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
			import.meta.url,
		).href;
		const live = new Map<ImageBitmap, number>();
		const createBitmap = originalCreate.bind(window);
		let bitmapBytes = 0;
		let peakBitmapBytes = 0;
		let pendingBitmaps = 0;
		let created = 0;
		// Avoid spy call histories: those retain every canvas and invalidate heap trends.
		window.createImageBitmap = (async (
			...args: Parameters<typeof createImageBitmap>
		) => {
			pendingBitmaps++;
			try {
				const bitmap = await createBitmap(...args);
				const bytes = bitmap.width * bitmap.height * 4;
				live.set(bitmap, bytes);
				bitmapBytes += bytes;
				peakBitmapBytes = Math.max(peakBitmapBytes, bitmapBytes);
				created++;
				return bitmap;
			} finally {
				pendingBitmaps--;
			}
		}) as typeof window.createImageBitmap;
		ImageBitmap.prototype.close = function (this: ImageBitmap) {
			bitmapBytes -= live.get(this) ?? 0;
			live.delete(this);
			originalClose.call(this);
		};
		const results: unknown[] = [];
		for (let cycle = 0; cycle < __LECTOR_SOAK_CYCLES__; cycle++) {
			// Drop every viewer/store/DOM reference before sampling the post-cleanup heap.
			const result = await (async () => {
				const name = cycle % 2 ? "expensive" : "large";
				const colorScheme = cycle % 2 ? "dark" : "light";
				let store: ReturnType<typeof PDFStore.useContext> | undefined;
				function Probe() {
					store = PDFStore.useContext();
					return null;
				}
				const errors: unknown[] = [];
				const mountedCanvases = new Set<WeakRef<HTMLCanvasElement>>();
				const observer = new MutationObserver((mutations) => {
					for (const mutation of mutations)
						for (const node of mutation.addedNodes) {
							if (node instanceof HTMLCanvasElement)
								mountedCanvases.add(new WeakRef(node));
							if (node instanceof Element)
								for (const canvas of node.querySelectorAll("canvas"))
									mountedCanvases.add(new WeakRef(canvas));
						}
				});
				observer.observe(document.body, { childList: true, subtree: true });
				const begin = performance.now();
				let unmount = () => {};
				try {
					const view = render(
						<Root
							source={
								new URL(`../../docs/public/pdf/${name}.pdf`, import.meta.url)
									.href
							}
							colorScheme={colorScheme}
							onError={(error) => errors.push(error)}
							style={{ height: 650, width: IS_MOBILE_DEVICE ? 370 : 800 }}
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
					unmount = () => view.unmount();
					await waitFor(
						() => expect(store?.getState().renderedPages[1]).toBe(true),
						{ timeout: 30000 },
					);
					const readyMs = performance.now() - begin;
					const viewport = store!.getState().viewportRef.current!;
					const frames: number[] = [];
					let last = performance.now();
					let peakCanvasBytes = 0;
					let peakCanvases = 0;
					peakBitmapBytes = bitmapBytes;
					const createdBefore = created;
					for (let frame = 0; frame < 120; frame++) {
						await new Promise<void>((resolve) =>
							requestAnimationFrame(() => {
								const now = performance.now();
								frames.push(now - last);
								last = now;
								const phase = frame % 60;
								const fraction = phase < 30 ? phase / 29 : (59 - phase) / 29;
								viewport.scrollTop =
									fraction *
									Math.max(0, viewport.scrollHeight - viewport.clientHeight);
								if (frame % 6 === 0)
									store!
										.getState()
										.updateZoom(
											[0.6, 1, 1.8, 3, 1.8, 1][Math.floor(frame / 6) % 6]!,
										);
								const canvases = [...view.container.querySelectorAll("canvas")];
								peakCanvases = Math.max(peakCanvases, canvases.length);
								peakCanvasBytes = Math.max(
									peakCanvasBytes,
									canvases.reduce((sum, c) => sum + c.width * c.height * 4, 0),
								);
								resolve();
							}),
						);
					}
					act(() => store!.getState().updateZoom(1));
					viewport.scrollTop = 0;
					await waitFor(
						() => expect(store!.getState().renderedPages[1]).toBe(true),
						{ timeout: 30000 },
					);
					await act(settle);
					frames.sort((a, b) => a - b);
					const mountedBitmapBytes = bitmapBytes;
					view.unmount();
					await waitFor(
						() => {
							expect(pendingBitmaps).toBe(0);
							expect(live.size).toBe(0);
						},
						{ timeout: 10000 },
					);
					expect(
						[...mountedCanvases].every((ref) => {
							const canvas = ref.deref();
							return !canvas || canvas.width <= 1;
						}),
					).toBe(true);
					expect(errors).toEqual([]);
					expect(peakCanvases).toBeLessThanOrEqual(20);
					return {
						cycle,
						name,
						colorScheme,
						mobileEmulation: IS_MOBILE_DEVICE,
						dpr: devicePixelRatio,
						cpuRate: __LECTOR_SOAK_CPU_RATE__,
						readyMs,
						frameP95Ms: frames[Math.floor(frames.length * 0.95)],
						framesOver32ms: frames.filter((ms) => ms > 32).length,
						peakCanvases,
						peakCanvasBytes,
						peakBitmapBytes,
						mountedBitmapBytes,
						bitmapsCreated: created - createdBefore,
						liveBitmapsAfterUnmount: live.size,
					};
				} finally {
					unmount();
					observer.disconnect();
					mountedCanvases.clear();
					cleanup();
				}
			})();
			await protocol.send("HeapProfiler.collectGarbage");
			const heap = await protocol.send("Runtime.getHeapUsage");
			const sample = { ...result, heapUsedAfterGc: heap.usedSize };
			results.push(sample);
			console.info(`SOAK_CYCLE ${JSON.stringify(sample)}`);
		}
		console.info(`SOAK_RESULT ${JSON.stringify(results)}`);
	} finally {
		window.createImageBitmap = originalCreate;
		ImageBitmap.prototype.close = originalClose;
		await protocol.send("Emulation.setCPUThrottlingRate", { rate: 1 });
	}
});
