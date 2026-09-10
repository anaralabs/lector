import { cleanup, render, waitFor } from "@testing-library/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, it } from "vitest";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
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
