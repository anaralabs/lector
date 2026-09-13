import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { usePDFPageNumber } from "../src/hooks/usePdfPageNumber";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";

declare const __LECTOR_SOAK_CPU_RATE__: number;
const frame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(cleanup);
function Content() {
	const number = usePDFPageNumber();
	return (
		<>
			<span data-page={number} />
			<CanvasLayer />
			<TextLayer />
		</>
	);
}

test("measures first paint, continuous scrolling and wheel response on real PDFs", async () => {
	const protocol = cdp();
	await protocol.send("Emulation.setCPUThrottlingRate", {
		rate: __LECTOR_SOAK_CPU_RATE__,
	});
	const rows = [];
	try {
		const pdfjs = await loadPdfJs();
		pdfjs.GlobalWorkerOptions.workerSrc = new URL(
			"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
			import.meta.url,
		).href;
		for (const name of ["large", "expensive"]) {
			for (let trial = 0; trial < 4; trial++) {
				let store!: ReturnType<typeof PDFStore.useContext>;
				function Probe() {
					store = PDFStore.useContext();
					return null;
				}
				const errors: unknown[] = [];
				const start = performance.now();
				const view = render(
					<Root
						source={
							new URL(`../../docs/public/pdf/${name}.pdf`, import.meta.url).href
						}
						progressive
						zoomOptions={{ minZoom: 0.1, maxZoom: 4 }}
						colorScheme={name === "large" ? "light" : "dark"}
						style={{ width: 800, height: 650 }}
						onError={(error) => errors.push(error)}
					>
						<Probe />
						<Pages>
							<Page>
								<Content />
							</Page>
						</Pages>
					</Root>,
				);
				await waitFor(
					() => expect(store?.getState().renderedPages[1]).toBe(true),
					{ timeout: 30000 },
				);
				const firstCanvasMs = performance.now() - start;
				const viewport = store.getState().viewportRef.current!;
				await delay(400);
				const frames = [];
				let last = performance.now();
				for (let i = 0; i < 90; i++) {
					viewport.scrollTop += 24;
					await frame();
					const now = performance.now();
					frames.push(now - last);
					last = now;
				}
				await delay(400);
				const initialZoom = store.getState().zoom;
				const inputAt = performance.now();
				let responseMs: number | undefined;
				const unsubscribe = store.subscribe((state) => {
					if (responseMs === undefined && state.zoom !== initialZoom)
						responseMs = performance.now() - inputAt;
				});
				act(() =>
					viewport.dispatchEvent(
						new WheelEvent("wheel", {
							deltaY: -30,
							ctrlKey: true,
							clientX: 300,
							clientY: 300,
							bubbles: true,
							cancelable: true,
						}),
					),
				);
				await delay(350);
				unsubscribe();
				expect(responseMs).toBeDefined();
				// Isolate active-gesture coverage from device-specific pinch delivery.
				act(() => store.getState().setIsPinching(true));
				act(() => store.getState().updateZoom(0.25));
				await delay(350);
				const state = store.getState();
				const top = viewport.scrollTop / state.zoom;
				const bottom = top + viewport.clientHeight / state.zoom;
				const mounted = new Set(
					[...view.container.querySelectorAll("[data-page]")].map((el) =>
						Number(el.getAttribute("data-page")),
					),
				);
				let offset = 0;
				const missingPages: number[] = [];
				state.viewports.forEach((page, i) => {
					if (
						offset < bottom &&
						offset + page.height > top &&
						!mounted.has(i + 1)
					)
						missingPages.push(i + 1);
					offset += page.height + 10;
				});
				act(() => store.getState().setIsPinching(false));
				frames.sort((a, b) => a - b);
				rows.push({
					name,
					trial,
					firstCanvasMs,
					scrollP95Ms: frames[Math.floor(frames.length * 0.95)],
					scrollFramesOver32Ms: frames.filter((ms) => ms > 32).length,
					wheelResponseMs: responseMs,
					missingPagesDuringZoom: missingPages,
				});
				view.unmount();
				expect(errors).toEqual([]);
				await delay(200);
			}
		}
		console.log(
			"INTERACTION_FEEL",
			JSON.stringify({
				cpuRate: __LECTOR_SOAK_CPU_RATE__,
				userAgent: navigator.userAgent,
				scrollFrames: 90,
				scrollStepPx: 24,
				warmupTrialsPerPdf: 1,
				rows,
			}),
		);
	} finally {
		await protocol.send("Emulation.setCPUThrottlingRate", { rate: 1 });
	}
}, 120000);
