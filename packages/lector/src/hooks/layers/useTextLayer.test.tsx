import { render, waitFor } from "@testing-library/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { ReactNode } from "react";
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

const createPageProxy = (pageNumber = 1): PDFPageProxy =>
	({
		pageNumber,
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

const createWrapper = ({
	pageProxies,
	viewports,
	pageNumber = 1,
}: {
	pageProxies: PDFPageProxy[];
	viewports: PageViewport[];
	pageNumber?: number;
}) => {
	return ({ children }: { children: ReactNode }) => (
		<PDFStore.Provider
			initialValue={{
				pdfDocumentProxy: createDocumentProxy(),
				pageProxies,
				viewports,
				zoom: 1,
			}}
		>
			<PDFPageNumberContext.Provider value={pageNumber}>
				{children}
			</PDFPageNumberContext.Provider>
		</PDFStore.Provider>
	);
};

describe("TextLayer rendering lifecycle", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		document.body.innerHTML = "";
	});

	it("uses measured DOM width to avoid oversized selection spans", async () => {
		const pageProxy = createPageProxy();
		const wrapper = createWrapper({
			pageProxies: [pageProxy],
			viewports: [createViewport(595, 842)],
		});

		const { container } = render(<TextLayer mode="pretext" />, { wrapper });

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

	it("restores cached DOM immediately when a page remounts", async () => {
		const pageProxy = createPageProxy();
		const wrapper = createWrapper({
			pageProxies: [pageProxy],
			viewports: [createViewport(595, 842)],
		});

		const firstRender = render(<TextLayer mode="pretext" />, { wrapper });
		await waitFor(() => {
			expect(
				firstRender.container.querySelectorAll(".textLayer span").length,
			).toBeGreaterThan(0);
		});

		firstRender.unmount();

		const secondRender = render(<TextLayer mode="pretext" />, { wrapper });

		expect(
			secondRender.container.querySelectorAll(".textLayer span").length,
		).toBeGreaterThan(0);

		await waitFor(() => {
			expect(
				secondRender.container.querySelector(".textLayer .endOfContent"),
			).not.toBeNull();
		});
	});
});
