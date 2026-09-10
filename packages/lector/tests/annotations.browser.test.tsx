import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AnnotationHighlightLayer } from "../src/components/layers/annotation-highlight-layer";
import {
	type Annotation,
	AnnotationsStoreProvider,
	useAnnotations,
	usePageAnnotations,
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

test("measure repeated annotation edits with a warm page index", () => {
	let store!: ReturnType<typeof useAnnotations>;
	function Probe() {
		store = useAnnotations();
		return null;
	}
	function PageProbe({ pageNumber }: { pageNumber: number }) {
		usePageAnnotations(pageNumber);
		return null;
	}
	render(
		<AnnotationsStoreProvider>
			<Probe />
			{Array.from({ length: 20 }, (_, i) => i + 1).map((pageNumber) => (
				<PageProbe key={pageNumber} pageNumber={pageNumber} />
			))}
		</AnnotationsStoreProvider>,
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
	act(() => store.setAnnotations(items));
	const samples: number[] = [];
	for (let round = 0; round < 8; round++) {
		const start = performance.now();
		for (let i = 0; i < 100; i++)
			act(() => store.updateAnnotation("9999", { comment: `${round}:${i}` }));
		if (round > 0) samples.push(performance.now() - start);
	}
	console.info(`QUALITY annotation-100-edits-ms: ${JSON.stringify(samples)}`);
	expect(store.annotations[9999]?.comment).toBe("7:99");
});
