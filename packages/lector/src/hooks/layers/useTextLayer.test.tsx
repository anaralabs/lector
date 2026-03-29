import { render, waitFor } from "@testing-library/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TextLayer } from "../../components/layers/text-layer";
import { PDFPageNumberContext } from "../../hooks/usePdfPageNumber";
import { PDFStore } from "../../internal";

vi.mock("../../lib/pdfjs", () => ({
	loadPdfJs: vi.fn(async () => ({
		TextLayer: class MockTextLayer {
			render() {
				return Promise.resolve();
			}
			cancel() {}
		},
	})),
}));

const createViewport = (width: number, height: number): PageViewport =>
	({
		width,
		height,
	}) as PageViewport;

const createPageProxy = (): PDFPageProxy =>
	({
		pageNumber: 1,
		rotate: 0,
		view: [0, 0, 595, 842],
		getViewport: vi.fn(() => createViewport(595, 842)),
		getTextContent: vi.fn(async () => ({
			items: [
				{
					str: "Methods:",
					dir: "ltr",
					transform: [11, 0, 0, 11, 56.622, 294.6],
					width: 40.7,
					height: 11,
					fontName: "f1",
					hasEOL: false,
				},
				{
					str: " tumors were measured",
					dir: "ltr",
					transform: [11, 0, 0, 11, 98, 294.6],
					width: 120,
					height: 11,
					fontName: "f1",
					hasEOL: false,
				},
			],
			styles: {
				f1: {
					ascent: 0.8,
					descent: -0.2,
					vertical: false,
					fontFamily: "sans-serif",
				},
			},
			lang: "en",
		})),
		streamTextContent: vi.fn(),
	}) as unknown as PDFPageProxy;

const createDocumentProxy = (): PDFDocumentProxy =>
	({
		numPages: 1,
		fingerprints: ["test-doc"],
	}) as PDFDocumentProxy;

describe("TextLayer selection scaling", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		document.body.innerHTML = "";
	});

	it("uses measured DOM width to avoid oversized selection spans", async () => {
		const pageProxy = createPageProxy();
		const documentProxy = createDocumentProxy();
		const viewports = [createViewport(595, 842)];

		const { container } = render(
			<PDFStore.Provider
				initialValue={{
					pdfDocumentProxy: documentProxy,
					pageProxies: [pageProxy],
					viewports,
					zoom: 1,
				}}
			>
				<PDFPageNumberContext.Provider value={1}>
					<TextLayer mode="pretext" />
				</PDFPageNumberContext.Provider>
			</PDFStore.Provider>,
		);

		await waitFor(() => {
			expect(
				container.querySelectorAll(".textLayer span").length,
			).toBeGreaterThan(0);
		});

		const spans = Array.from(
			container.querySelectorAll<HTMLSpanElement>(".textLayer span"),
		);
		expect(spans.length).toBeGreaterThan(0);

		for (const span of spans) {
			const scaleX = span.style.getPropertyValue("--scale-x");
			expect(scaleX).not.toBe("");
			expect(Number(scaleX)).toBeGreaterThan(0.5);
			expect(Number(scaleX)).toBeLessThan(1.5);
		}
	});
});
