import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { Search } from "../src/components/search";
import { Thumbnail } from "../src/components/thumbnails";
import { usePDFPageNumber } from "../src/hooks/usePdfPageNumber";
import { PDFStore, usePdf } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";

beforeAll(async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
});
afterEach(cleanup);
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

for (const progressive of [false, true]) {
	test(`${progressive ? "progressive" : "eager"} loading withholds unrelated blocked pages ${progressive ? "from first paint" : "until the complete document is ready"}`, async () => {
		const gate = deferred();
		let requested = 0;
		let store: ReturnType<typeof PDFStore.useContext> | undefined;
		function Probe() {
			store = PDFStore.useContext();
			return null;
		}
		const view = render(
			<Root
				source={createTextPdf(24, 1)}
				progressive={progressive}
				loader={<span>Opening document</span>}
				style={{ height: 600, width: 800 }}
				onDocumentLoad={({ proxy }) => {
					const getPage = proxy.getPage.bind(proxy);
					proxy.getPage = async (number) => {
						requested++;
						if (number !== 1) await gate.promise;
						return getPage(number);
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
		try {
			await waitFor(() => expect(requested).toBeGreaterThan(1));
			if (progressive) {
				await waitFor(() =>
					expect(store?.getState().renderedPages[1]).toBe(true),
				);
				expect(store!.getState().pagesLoaded).toBe(false);
				expect(store!.getState().pageProxies).toEqual([]);
				expect(() => store!.getState().getPdfPageProxy(24)).toThrow(
					"Await loadPdfPageProxy(24)",
				);
			} else {
				expect(view.getByText("Opening document")).toBeTruthy();
				expect(store).toBeUndefined();
			}
		} finally {
			gate.resolve();
		}
		await waitFor(() => expect(store?.getState().pagesLoaded).toBe(true));
		expect(
			store!.getState().pageProxies.map((page) => page.pageNumber),
		).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
	}, 15000);
}

for (const scenario of [
	{ zoom: 0.5 },
	{ zoom: 1 },
	{ zoom: 1.5 },
	{ zoom: 2 },
	{ zoom: 1, fit: true },
	{ zoom: 2, pinch: true },
]) {
	const { zoom } = scenario;
	test(`deep-linked page stays anchored when mixed-size rotated pages resolve at zoom ${zoom}${"fit" in scenario ? " fit-width" : ""}${"pinch" in scenario ? " during pinch" : ""}`, async () => {
		const gate = deferred();
		const requests: number[] = [];
		const sizes = Array.from({ length: 20 }, (_, i) =>
			i === 1
				? { width: 900, height: 500, rotation: 90 }
				: { width: 612, height: 792, rotation: 0 },
		);
		let store!: ReturnType<typeof PDFStore.useContext>;
		function Probe() {
			store = PDFStore.useContext();
			return null;
		}
		function Marker() {
			const number = usePDFPageNumber();
			return <span data-marker={number} />;
		}
		const view = render(
			<Root
				source={createTextPdf(20, 1, sizes)}
				progressive
				initialPage={10}
				zoom={zoom}
				isZoomFitWidth={"fit" in scenario}
				style={{ height: 500, width: 800 }}
				onDocumentLoad={({ proxy }) => {
					const getPage = proxy.getPage.bind(proxy);
					proxy.getPage = async (number) => {
						requests.push(number);
						if (number !== 10) await gate.promise;
						return getPage(number);
					};
				}}
			>
				<Probe />
				<Pages data-testid="viewport">
					<Page data-testid="pdf-page">
						<Marker />
						<CanvasLayer />
					</Page>
				</Pages>
			</Root>,
		);
		try {
			await waitFor(() =>
				expect(store?.getState().renderedPages[10]).toBe(true),
			);
			expect(requests[0]).toBe(10);
			const viewport = view.getByTestId("viewport");
			const effectiveZoom = "fit" in scenario ? 800 / 612 : zoom;
			await waitFor(() =>
				expect(Math.abs(store.getState().zoom - effectiveZoom)).toBeLessThan(
					0.001,
				),
			);
			await waitFor(() =>
				expect(
					Math.abs(viewport.scrollTop - 9 * 802 * effectiveZoom),
				).toBeLessThan(3),
			);
			const before = viewport.scrollTop;
			const markerTop = () =>
				view.container
					.querySelector('[data-marker="10"]')!
					.getBoundingClientRect().top;
			const beforeTop = markerTop();
			if ("pinch" in scenario) act(() => store.getState().setIsPinching(true));
			gate.resolve();
			await waitFor(() => expect(store.getState().pagesLoaded).toBe(true));
			await waitFor(() =>
				expect(store.getState().viewports[1]?.height).toBe(900),
			);
			if ("pinch" in scenario) {
				expect(Math.abs(viewport.scrollTop - before)).toBeLessThan(3);
				act(() => store.getState().setIsPinching(false));
				// No stale frozen page positions may paint after the gesture ends.
				expect(Math.abs(markerTop() - beforeTop)).toBeLessThan(3);
			}
			await waitFor(() =>
				expect(
					Math.abs(viewport.scrollTop - before - 108 * effectiveZoom),
				).toBeLessThan(3),
			);
			await waitFor(() => expect(store.getState().currentPage).toBe(10));
		} finally {
			gate.resolve();
		}
	}, 15000);
}

test("page and search errors remain retryable, and direct thumbnails wait for real proxies", async () => {
	const gate = deferred();
	let fail = true;
	const onError = vi.fn();
	let store!: ReturnType<typeof PDFStore.useContext>;
	function SearchReady() {
		const content = usePdf((state) => state.textContent);
		return <span>Indexed {content.length} pages</span>;
	}
	function Probe() {
		store = PDFStore.useContext();
		return null;
	}
	const view = render(
		<Root
			source={createTextPdf(3, 1)}
			progressive
			onError={onError}
			onDocumentLoad={({ proxy }) => {
				const getPage = proxy.getPage.bind(proxy);
				proxy.getPage = async (number) => {
					if (number === 3) {
						await gate.promise;
						if (fail) throw new Error("temporary page failure");
					}
					return getPage(number);
				};
			}}
		>
			<Probe />
			<Page pageNumber={1}>
				<CanvasLayer />
			</Page>
			<Thumbnail pageNumber={3} eager />
			<Search loading={<span>Indexing pages</span>}>
				<SearchReady />
			</Search>
		</Root>,
	);
	try {
		await waitFor(() =>
			expect(view.getByLabelText("Loading page 3")).toBeTruthy(),
		);
		expect(view.getByText("Indexing pages")).toBeTruthy();
		expect(store.getState().textContent).toEqual([]);
		await act(async () => gate.resolve());
		await waitFor(() => expect(view.getAllByRole("alert")).toHaveLength(2));
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "viewport-generation" }),
		);
		fail = false;
		act(() => {
			for (const retry of view.getAllByRole("button", { name: "Retry" }))
				retry.click();
		});
		await waitFor(() => expect(view.getByText("Indexed 3 pages")).toBeTruthy());
		await waitFor(() =>
			expect(view.getByRole("button", { name: "Page 3" })).toBeTruthy(),
		);
		expect(store.getState().pageProxies).toHaveLength(3);
	} finally {
		gate.resolve();
	}
}, 15000);

test("replacing a progressive document ignores late resources from the disposed document", async () => {
	const gate = deferred();
	const onError = vi.fn();
	let store: ReturnType<typeof PDFStore.useContext> | undefined;
	function Probe() {
		store = PDFStore.useContext();
		return null;
	}
	const first = createTextPdf(20, 1);
	const second = createTextPdf(3, 1);
	const children = (
		<>
			<Probe />
			<Pages>
				<Page>
					<CanvasLayer />
				</Page>
			</Pages>
		</>
	);
	const view = render(
		<Root
			source={first}
			progressive
			onError={onError}
			style={{ height: 600, width: 800 }}
			onDocumentLoad={({ proxy }) => {
				const getPage = proxy.getPage.bind(proxy);
				proxy.getPage = async (number) => {
					if (number !== 1) await gate.promise;
					return getPage(number);
				};
			}}
		>
			{children}
		</Root>,
	);
	try {
		await waitFor(() => expect(store?.getState().renderedPages[1]).toBe(true));
		view.rerender(
			<Root
				source={second}
				progressive
				onError={onError}
				style={{ height: 600, width: 800 }}
			>
				{children}
			</Root>,
		);
		await waitFor(() =>
			expect(store?.getState().pdfDocumentProxy.numPages).toBe(3),
		);
		await waitFor(() => expect(store?.getState().pagesLoaded).toBe(true));
		await act(async () => {
			gate.resolve();
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(store!.getState().pageProxies).toHaveLength(3);
		expect(onError).not.toHaveBeenCalled();
	} finally {
		gate.resolve();
	}
}, 15000);
