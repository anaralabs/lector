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

async function reader(
	stableZoom: boolean,
	options: { initialPage?: number; initialOffset?: number } = {},
) {
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
			initialPage={options.initialPage}
			style={{ height: 600, width: 800 }}
		>
			<Probe />
			<Pages initialOffset={options.initialOffset}>
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

	test.each([
		["initialPage", { initialPage: 3 }],
		["initialOffset", { initialOffset: 2000 }],
	] as const)("restores %s on open", async (_, options) => {
		const r = await reader(stableZoom, options);
		await sleep(300);
		expect(r.viewport().scrollTop).toBeGreaterThan(1000);
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

test("pages land in the same place with and without stable zoom", async () => {
	const place = async (stableZoom: boolean) => {
		const r = await reader(stableZoom);
		const rows: Array<{ page: number[]; scrollWidth: number }> = [];
		for (const zoom of [3, 1, 0.5]) {
			act(() => r.store.getState().updateZoom(() => zoom));
			await waitFor(
				() =>
					expect(r.textLayer().getBoundingClientRect().width).toBeCloseTo(
						612 * zoom,
						0,
					),
				{ timeout: 5000 },
			);
			const { left, top, width, height } = r
				.textLayer()
				.getBoundingClientRect();
			rows.push({
				page: [left, top, width, height, r.viewport().scrollHeight],
				scrollWidth: r.viewport().scrollWidth,
			});
		}
		cleanup();
		return rows;
	};
	const stable = await place(true);
	const plain = await place(false);
	stable.forEach((row, i) =>
		row.page.forEach((value, j) =>
			expect(value).toBeCloseTo(plain[i]!.page[j]!, 0),
		),
	);
	// Zoomed back out, the 612 px page fits the 800 px viewport: no horizontal scroll.
	expect(stable.at(-1)!.scrollWidth).toBeLessThanOrEqual(800);
});
