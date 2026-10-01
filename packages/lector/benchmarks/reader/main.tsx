import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasLayer } from "../../src/components/layers/canvas-layer";
import { TextLayer } from "../../src/components/layers/text-layer";
import { Page } from "../../src/components/page";
import { Pages } from "../../src/components/pages";
import { Root } from "../../src/components/root";
import { usePDFPageNumber } from "../../src/hooks/usePdfPageNumber";
import { PDFStore } from "../../src/internal";
import { loadPdfJs } from "../../src/lib/pdfjs";

const params = new URLSearchParams(location.search);
const firstPage = Number(params.get("page")) || 1;
const metrics = {
	appMs: performance.now(),
	proxyMs: 0,
	shellMs: 0,
	firstCanvasMs: 0,
	errors: [] as string[],
	documentLoads: [] as { source: string; numPages: number }[],
};
let store: ReturnType<typeof PDFStore.useContext>;
function Probe() {
	store = PDFStore.useContext();
	useLayoutEffect(() => {
		metrics.shellMs ||= performance.now();
		const update = () => {
			if (store.getState().renderedPages[firstPage])
				metrics.firstCanvasMs ||= performance.now();
		};
		update();
		return store.subscribe(update);
	}, []);
	return null;
}
function Content() {
	const number = usePDFPageNumber();
	return (
		<>
			<span data-page-marker={number} />
			<CanvasLayer data-base-canvas />
			<TextLayer />
		</>
	);
}
const pdfjs = await loadPdfJs();
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
	"../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
	import.meta.url,
).href;
const frame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

// Geometry is sampled only in the harness, never in library scroll handlers.
function coverage() {
	const state = store.getState();
	const viewport = state.viewportRef.current!;
	const top = viewport.scrollTop / state.zoom;
	const bottom = top + viewport.clientHeight / state.zoom;
	let offset = 0,
		total = 0,
		blank = 0;
	for (let i = 0; i < state.viewports.length; i++) {
		const height = state.viewports[i]!.height;
		const visible = Math.max(
			0,
			Math.min(bottom, offset + height) - Math.max(top, offset),
		);
		if (visible) {
			total += visible;
			const canvas = document
				.querySelector(`[data-page-marker="${i + 1}"]`)
				?.parentElement?.querySelector<HTMLCanvasElement>("[data-base-canvas]");
			if (!canvas || canvas.width <= 1 || canvas.style.visibility === "hidden")
				blank += visible;
		}
		offset += height + 10;
		if (offset > bottom) break;
	}
	return total ? blank / total : 0;
}

async function scroll() {
	const viewport = store.getState().viewportRef.current!;
	const rows = [];
	// Revisit pages at a different scale after they have left the virtual range.
	for (const zoom of [1, 1.2]) {
		store.getState().updateZoom(zoom);
		viewport.scrollTop = 0;
		await delay(500);
		let weightedBlankMs = 0,
			framesWithBlank = 0,
			peakOffset = 0,
			last = performance.now();
		const frames: number[] = [];
		for (let i = 0; i < 120; i++) {
			const progress = i < 60 ? i : 119 - i;
			viewport.scrollTop = progress * 240 * zoom;
			peakOffset = Math.max(peakOffset, viewport.scrollTop);
			await frame();
			const now = performance.now(),
				dt = now - last;
			last = now;
			frames.push(dt);
			const blank = coverage();
			weightedBlankMs += blank * dt;
			if (blank > 0.01) framesWithBlank++;
		}
		const settled = performance.now();
		while (coverage() > 0 && performance.now() - settled < 10000) await frame();
		frames.sort((a, b) => a - b);
		rows.push({
			zoom,
			peakOffset,
			viewportHeight: viewport.clientHeight,
			scrollHeight: viewport.scrollHeight,
			weightedBlankMs,
			framesWithBlank,
			frames: frames.length,
			p95Ms: frames[Math.floor(frames.length * 0.95)],
			settleMs: performance.now() - settled,
		});
	}
	return rows;
}
function App() {
	const [source, setSource] = useState(
		`/pdf/${params.get("pdf") || "large"}.pdf`,
	);
	Object.assign(window, {
		lectorBenchmark: {
			metrics,
			scroll,
			replace: setSource,
			unmount: () => root.unmount(),
			currentSource: source,
			currentDocument: () => store?.getState().pdfDocumentProxy.numPages,
		},
	});
	return (
		<Root
			source={source}
			progressive={params.get("eager") !== "1"}
			initialPage={firstPage}
			colorScheme={params.get("dark") === "1" ? "dark" : "light"}
			style={{ height: "100%", width: "100%" }}
			loader={<div role="status">Opening document…</div>}
			documentOptions={{
				...(params.has("range")
					? { disableStream: true, disableAutoFetch: true }
					: {}),
				standardFontDataUrl: "/pdfjs/standard_fonts/",
				wasmUrl: "/pdfjs/wasm/",
				cMapUrl: "/pdfjs/cmaps/",
				iccUrl: "/pdfjs/iccs/",
			}}
			onDocumentLoad={({ proxy, source }) => {
				metrics.proxyMs = performance.now();
				metrics.documentLoads.push({
					source: String(source),
					numPages: proxy.numPages,
				});
			}}
			onError={({ error }) => metrics.errors.push(String(error))}
		>
			<Probe />
			<Pages>
				<Page>
					<Content />
				</Page>
			</Pages>
		</Root>
	);
}
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
