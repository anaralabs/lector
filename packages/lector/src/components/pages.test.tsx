import { cleanup, render, waitFor } from "@testing-library/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page as browserPage } from "vitest/browser";
import { PDFStore } from "../internal";
import { Page } from "./page";
import { Pages } from "./pages";

afterEach(cleanup);
const viewportSize = { width: window.innerWidth, height: window.innerHeight };
beforeAll(() => browserPage.viewport(1100, 700));
afterAll(() => browserPage.viewport(viewportSize.width, viewportSize.height));

function viewer(zoom: number, width = 900) {
	const viewports = [{ width: 600, height: 800 }] as PageViewport[];
	return render(
		<PDFStore.Provider
			initialValue={{
				pdfDocumentProxy: { numPages: 1 } as PDFDocumentProxy,
				pageProxies: [
					{ pageNumber: 1, view: [0, 0, 600, 800] },
				] as PDFPageProxy[],
				viewports,
				zoom,
			}}
		>
			<div style={{ width, height: 500 }}>
				<Pages data-testid="viewport">
					<Page data-testid="page">
						<span>Page content</span>
					</Page>
				</Pages>
			</div>
		</PDFStore.Provider>,
	);
}

describe("page alignment", () => {
	it.each([1, 0.75])(
		"centers pages at initial zoom %s without a zoom interaction",
		async (zoom) => {
			const view = viewer(zoom);
			await waitFor(() => {
				const page = view.getByTestId("page");
				const viewport = view.getByTestId("viewport").getBoundingClientRect();
				const left = viewport.left + (viewport.width - 600 * zoom) / 2;
				const right = left + 600 * zoom;
				// Older WebKit reports unzoomed getBoundingClientRect values for
				// CSS zoom. Hit-test both physical edges instead: this still catches
				// incorrect width or centering, in either zoom implementation.
				const hits = [left - 1, left + 1, right - 1, right + 1].map((x) =>
					page.contains(document.elementFromPoint(x, viewport.top + 10)),
				);
				expect(hits).toEqual([false, true, true, false]);
			});
		},
	);

	it("keeps the left edge of an oversized page reachable", async () => {
		const view = viewer(2, 400);
		await waitFor(() => {
			const page = view.getByTestId("page").getBoundingClientRect();
			const viewport = view.getByTestId("viewport");
			expect(page.left).toBeCloseTo(viewport.getBoundingClientRect().left, 0);
			expect(viewport.scrollWidth).toBeGreaterThanOrEqual(1200);
		});
	});
});
