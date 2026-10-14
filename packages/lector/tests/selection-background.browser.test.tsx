/// <reference types="vite/client" />
import { cleanup, render, waitFor } from "@testing-library/react";
import pdfViewerCss from "pdfjs-dist/web/pdf_viewer.css?inline";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";

beforeAll(async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
});

const styles: HTMLStyleElement[] = [];
const addStyle = (css: string) => {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
	styles.push(style);
};

afterEach(() => {
	cleanup();
	document.getSelection()?.removeAllRanges();
	for (const style of styles.splice(0)) style.remove();
});

const union = (rects: DOMRect[]) => ({
	left: Math.min(...rects.map((r) => r.left)),
	top: Math.min(...rects.map((r) => r.top)),
	right: Math.max(...rects.map((r) => r.right)),
	bottom: Math.max(...rects.map((r) => r.bottom)),
});

describe.each([
	["with pdf_viewer.css", true],
	["without pdf_viewer.css", false],
])("selection background %s", (_, withViewerCss) => {
	test.each([0, 90, 180, 270])(
		"covers the selected lines on a %s degree page",
		async (rotation) => {
			if (withViewerCss) addStyle(pdfViewerCss);
			addStyle(".textLayer ::selection { background: rgb(0, 100, 255); }");
			const view = render(
				<Root
					source={{
						data: createTextPdf(1, 3, [{ width: 612, height: 792, rotation }]),
					}}
					style={{ height: 900, width: 900 }}
				>
					<Pages>
						<Page>
							<TextLayer />
						</Page>
					</Pages>
				</Root>,
			);
			const layer = () =>
				view.container.querySelector<HTMLElement>(".textLayer");
			await waitFor(
				() =>
					expect(layer()?.querySelectorAll("span").length).toBeGreaterThan(1),
				{ timeout: 15000 },
			);
			const [first, second] = layer()!.querySelectorAll("span");
			const range = document.createRange();
			range.setStart(first!.firstChild!, 0);
			range.setEnd(second!.firstChild!, 20);
			document.getSelection()!.removeAllRanges();
			document.getSelection()!.addRange(range);
			document.dispatchEvent(new Event("selectionchange"));

			const path = await waitFor(() => {
				const element = layer()!.querySelector(
					"svg[data-lector-selection] path",
				);
				expect(element).toBeTruthy();
				return element!;
			});
			expect(path.getAttribute("d")!.split("M").filter(Boolean)).toHaveLength(
				2,
			);
			const painted = path.getBoundingClientRect();
			const selected = union(
				[...range.getClientRects()].filter((r) => r.width && r.height),
			);
			for (const side of ["left", "top", "right", "bottom"] as const)
				expect(Math.abs(painted[side] - selected[side])).toBeLessThan(1.5);
		},
	);
});
