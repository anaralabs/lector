import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { USE_LAYOUT_ZOOM } from "../src/lib/zoom";
import { createTextPdf } from "./fixtures/pdf";

beforeAll(async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
});
afterEach(cleanup);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reader(stableZoom: boolean) {
	let store!: ReturnType<typeof PDFStore.useContext>;
	function Probe() {
		store = PDFStore.useContext();
		return null;
	}
	const view = render(
		<Root
			source={createTextPdf(3, 20)}
			zoom={2}
			stableZoom={stableZoom}
			style={{ height: 600, width: 800 }}
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
	return {
		store,
		canvas: () => view.container.querySelector("canvas")!,
		textLayer: () =>
			view.container.querySelector<HTMLElement>(
				'.textLayer[data-page-number="1"]',
			)!,
		viewport: () => store.getState().viewportRef.current!,
	};
}

describe.each([true, false])("stableZoom=%s", (stableZoom) => {
	test("zooming out keeps the sharper canvas only with stable zoom", async () => {
		const r = await reader(stableZoom);
		const before = r.canvas().width;
		act(() => r.store.getState().updateZoom(() => 1));
		if (stableZoom) {
			await sleep(500);
			expect(r.canvas().width).toBe(before);
			if (USE_LAYOUT_ZOOM) {
				const pages = r.viewport().firstElementChild!
					.firstElementChild as HTMLElement;
				expect(pages.style.zoom).toBe("2");
				expect(pages.style.transform).toBe("scale3d(0.5, 0.5, 1)");
			}
		} else {
			await waitFor(() => expect(r.canvas().width).toBeLessThan(before), {
				timeout: 5000,
			});
		}
	});

	test("scrolling hides the text layer only without stable zoom", async () => {
		const r = await reader(stableZoom);
		await waitFor(
			() => expect(r.textLayer()?.querySelector("span")).toBeTruthy(),
			{
				timeout: 15000,
			},
		);
		act(() => {
			r.viewport().scrollTop += 40;
			r.viewport().dispatchEvent(new Event("scroll"));
		});
		await sleep(50);
		expect(r.textLayer().style.visibility).toBe(stableZoom ? "" : "hidden");
	});
});
