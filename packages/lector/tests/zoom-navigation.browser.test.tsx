import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useLayoutEffect } from "react";
import { afterEach, expect, it } from "vitest";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { usePDFPageNumber } from "../src/hooks/usePdfPageNumber";
import { PDFStore } from "../src/internal";

afterEach(cleanup);
it.each([0.5, 1, 2])(
	"restores a deep-linked page at initial zoom %s",
	async (zoom) => {
		const pages = Array.from({ length: 20 }, (_, i) => ({
			pageNumber: i + 1,
			view: [0, 0, 600, 800],
		})) as PDFPageProxy[];
		const result = render(
			<PDFStore.Provider
				initialValue={{
					pdfDocumentProxy: { numPages: 20 } as PDFDocumentProxy,
					pageProxies: pages,
					viewports: pages.map(
						() => ({ width: 600, height: 800 }) as PageViewport,
					),
					zoom,
					initialPage: 3,
				}}
			>
				<Pages data-testid="viewport" style={{ height: 500, width: 400 }}>
					<Page>
						<span>Page</span>
					</Page>
				</Pages>
			</PDFStore.Provider>,
		);
		await waitFor(() =>
			expect(result.getByTestId("viewport").scrollTop).toBeCloseTo(
				2 * 810 * zoom,
				0,
			),
		);
	},
);

it.each([
	{ zoom: 0.5, pendingGesture: false },
	{ zoom: 2, pendingGesture: false },
	{ zoom: 0.5, pendingGesture: true },
	{ zoom: 2, pendingGesture: true },
	{ zoom: 1, pendingGesture: true },
])(
	"keeps toolbar zoom synchronized before native scrolling (zoom=$zoom, pending=$pendingGesture)",
	async ({ zoom, pendingGesture }) => {
		const pages = Array.from({ length: 20 }, (_, i) => ({
			pageNumber: i + 1,
			view: [0, 0, 600, 800],
		})) as PDFPageProxy[];
		let store!: ReturnType<typeof PDFStore.useContext>;
		const mounts = new Map<number, number>();
		function Content() {
			const page = usePDFPageNumber();
			useLayoutEffect(() => {
				mounts.set(page, (mounts.get(page) ?? 0) + 1);
			}, [page]);
			return <span data-page={page}>Page {page}</span>;
		}
		function Toolbar() {
			store = PDFStore.useContext();
			return (
				<button type="button" onClick={() => store.getState().updateZoom(zoom)}>
					Zoom
				</button>
			);
		}
		const result = render(
			<PDFStore.Provider
				initialValue={{
					pdfDocumentProxy: { numPages: 20 } as PDFDocumentProxy,
					pageProxies: pages,
					viewports: pages.map(
						() => ({ width: 600, height: 800 }) as PageViewport,
					),
					zoom: 1,
					initialPage: 4,
				}}
			>
				<Toolbar />
				<Pages data-testid="viewport" style={{ height: 500, width: 400 }}>
					<Page>
						<Content />
					</Page>
				</Pages>
			</PDFStore.Provider>,
		);
		const viewport = result.getByTestId("viewport");
		await waitFor(() =>
			expect(store.getState().virtualizer?.scrollOffset).toBeCloseTo(2430, 0),
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const content = viewport.querySelector('[data-page="4"]');
		const initialMounts = mounts.get(4);
		expect(content).not.toBeNull();
		expect(initialMounts).toBeGreaterThan(0);
		const initialOffset = store.getState().virtualizer!.scrollOffset!;
		let events = 0;
		const holdScroll = (event: Event) => {
			events++;
			event.stopImmediatePropagation();
		};
		viewport.addEventListener("scroll", holdScroll, true);
		try {
			act(() => {
				if (pendingGesture) {
					for (let i = 0; i < 2; i++)
						viewport.dispatchEvent(
							new WheelEvent("wheel", {
								deltaY: -3,
								ctrlKey: true,
								clientX: 100,
								clientY: 100,
								bubbles: true,
								cancelable: true,
							}),
						);
					expect(store.getState().isPinching).toBe(true);
				}
				result.getByText("Zoom").click();
			});
			expect(events).toBe(0);
			// Browsers can snap physical scroll positions to device pixels.
			expect(Math.abs(viewport.scrollTop - initialOffset * zoom)).toBeLessThan(
				1,
			);
			expect(store.getState().virtualizer?.scrollOffset).toBeCloseTo(
				viewport.scrollTop / zoom,
				5,
			);
			expect(store.getState().virtualizer?.range?.startIndex).toBe(3);
			expect(viewport.querySelector('[data-page="4"]')).toBe(content);
			expect(mounts.get(4)).toBe(initialMounts);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			expect(store.getState().virtualizer?.scrollOffset).toBeCloseTo(
				viewport.scrollTop / zoom,
				5,
			);
			expect(
				Math.abs(store.getState().virtualizer!.scrollOffset! - initialOffset),
			).toBeLessThan(1 / zoom);
			expect(store.getState().virtualizer?.range?.startIndex).toBe(3);
			expect(mounts.get(4)).toBe(initialMounts);
			expect(store.getState().zoom).toBe(zoom);
		} finally {
			viewport.removeEventListener("scroll", holdScroll, true);
			result.unmount();
		}
		Object.defineProperty(viewport, "scrollTop", {
			get() {
				throw new Error("Read from disposed viewport");
			},
		});
		expect(() => store.getState().updateZoom(1)).not.toThrow();
	},
);
