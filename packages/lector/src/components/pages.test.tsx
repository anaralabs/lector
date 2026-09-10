import { cleanup, render, waitFor } from "@testing-library/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { afterEach, describe, expect, it } from "vitest";
import { PDFStore } from "../internal";
import { Page } from "./page";
import { Pages } from "./pages";

afterEach(cleanup);

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
				const page = view.getByTestId("page").getBoundingClientRect();
				const viewport = view.getByTestId("viewport").getBoundingClientRect();
				expect(page.width).toBeCloseTo(600 * zoom, 0);
				expect(
					Math.abs(
						(page.left + page.right - viewport.left - viewport.right) / 2,
					),
				).toBeLessThan(1);
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
