import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";

afterEach(cleanup);

test("real PDF.js document loads, renders text and canvas, zooms and unmounts", async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	let store: ReturnType<typeof PDFStore.useContext> | undefined;
	const errors: unknown[] = [];
	function Probe() {
		store = PDFStore.useContext();
		return null;
	}
	const start = performance.now();
	const view = render(
		<Root
			source={new URL("../src/static/form.pdf", import.meta.url).href}
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
	await waitFor(() => expect(store?.getState().renderedPages[1]).toBe(true), {
		timeout: 15000,
	});
	await waitFor(() =>
		expect(
			view.container.querySelectorAll(".textLayer span").length,
		).toBeGreaterThan(0),
	);
	console.info(
		`PERF real-form-first-render: ${(performance.now() - start).toFixed(2)}ms; pages=${store!.getState().pdfDocumentProxy.numPages}`,
	);
	const baseCanvas = view.container.querySelector("canvas")!;
	const pixels = baseCanvas
		.getContext("2d")!
		.getImageData(0, 0, baseCanvas.width, baseCanvas.height).data;
	expect(pixels.some((value, index) => index % 4 !== 3 && value < 240)).toBe(
		true,
	);
	act(() => store!.getState().updateZoom(2));
	await waitFor(() => expect(store!.getState().zoom).toBe(2));
	await new Promise((resolve) => setTimeout(resolve, 350));
	expect(errors).toEqual([]);
	const canvases = Array.from(view.container.querySelectorAll("canvas"));
	expect(canvases.some((canvas) => canvas.width > 1)).toBe(true);
	view.unmount();
	expect(canvases.every((canvas) => canvas.width <= 1)).toBe(true);
}, 20000);
