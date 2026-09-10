import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AnnotationHighlightLayer } from "../src/components/layers/annotation-highlight-layer";
import {
	type Annotation,
	AnnotationsStoreProvider,
	useAnnotations,
} from "../src/hooks/useAnnotations";
import { PDFPageNumberContext } from "../src/hooks/usePdfPageNumber";
import { PDFStore } from "../src/internal";
import { wrapperFor } from "./helpers";

afterEach(cleanup);
test("editing an offscreen annotation does not render visible annotation layers", () => {
	let annotations!: ReturnType<typeof useAnnotations>;
	let pdf!: ReturnType<typeof PDFStore.useContext>;
	function Probe() {
		annotations = useAnnotations();
		pdf = PDFStore.useContext();
		return null;
	}
	const hover = vi.fn(() => null);
	const pages = Array.from({ length: 20 }, (_, i) => i + 1);
	render(
		<AnnotationsStoreProvider>
			<Probe />
			{pages.map((pageNumber) => (
				<PDFPageNumberContext.Provider value={pageNumber} key={pageNumber}>
					<AnnotationHighlightLayer
						renderTooltipContent={() => null}
						renderHoverTooltipContent={hover}
					/>
				</PDFPageNumberContext.Provider>
			))}
		</AnnotationsStoreProvider>,
		{ wrapper: wrapperFor() },
	);
	const items = Array.from(
		{ length: 10000 },
		(_, i): Annotation => ({
			id: String(i),
			pageNumber: Math.floor(i / 10) + 1,
			highlights: [
				{
					pageNumber: Math.floor(i / 10) + 1,
					top: 10,
					left: 10,
					width: 10,
					height: 10,
				},
			],
			color: "yellow",
			borderColor: "orange",
			createdAt: new Date(0),
			updatedAt: new Date(0),
		}),
	);
	act(() => {
		for (const page of pages) pdf.getState().markPageRendered(page);
		annotations.setAnnotations(items);
	});
	hover.mockClear();
	const start = performance.now();
	act(() =>
		annotations.updateAnnotation("9999", { comment: "edited offscreen" }),
	);
	console.info(
		`AUDIT annotations 10000/20-visible-pages: offscreenEditMs=${(performance.now() - start).toFixed(1)}, visibleTooltipRenders=${hover.mock.calls.length}`,
	);
	expect(hover.mock.calls.length).toBe(0);
});
