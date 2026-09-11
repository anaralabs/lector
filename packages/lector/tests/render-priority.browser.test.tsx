import { cleanup, render, waitFor } from "@testing-library/react";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { afterEach, expect, test, vi } from "vitest";
import { useCanvasLayer } from "../src/hooks/layers/useCanvasLayer";
import { PDFPageNumberContext } from "../src/hooks/usePdfPageNumber";
import { PDFStore, type PDFVirtualizer } from "../src/internal";
import { wrapperFor } from "./helpers";

afterEach(cleanup);
function setup(pageNumber: number, zoom = 1) {
	const viewport = document.createElement("div");
	document.body.append(viewport);
	const virtualizer = {
		isScrolling: true,
		range: { startIndex: 0, endIndex: 0 },
		scrollRect: { width: 600, height: 650 / zoom },
		scrollOffset: 0,
		getVirtualItems: () => [
			{ index: 0, start: 0, end: 800 },
			{ index: 1, start: 810, end: 1610 },
		],
	} as PDFVirtualizer;
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const task = {
		promise: new Promise<void>((yes, no) => {
			resolve = yes;
			reject = no;
		}),
		cancel: vi.fn(() =>
			reject(
				Object.assign(new Error("cancelled"), {
					name: "RenderingCancelledException",
				}),
			),
		),
	} as unknown as RenderTask;
	const proxy = {
		pageNumber,
		getViewport: () => ({ width: 600, height: 800 }),
		render: () => task,
	} as unknown as PDFPageProxy;
	const pages = Array.from({ length: pageNumber }, () => proxy);
	function Canvas() {
		const { canvasRef } = useCanvasLayer({});
		return <canvas ref={canvasRef} />;
	}
	function Harness() {
		const store = PDFStore.useContext();
		store.setState({ virtualizer, zoom, viewportRef: { current: viewport } });
		return (
			<PDFPageNumberContext.Provider value={pageNumber}>
				<Canvas />
			</PDFPageNumberContext.Provider>
		);
	}
	const view = render(<Harness />, { wrapper: wrapperFor(pages) });
	const work = vi.fn(resolve);
	const continueRender = () =>
		task.onContinue ? task.onContinue(work) : work();
	return {
		virtualizer,
		viewport,
		task,
		work,
		continueRender,
		unmount: () => {
			view.unmount();
			viewport.remove();
		},
	};
}
test("does not paint overscan pages while fast scrolling and resumes when they become visible", async () => {
	const fixture = setup(2);
	try {
		fixture.continueRender();
		expect(fixture.work).not.toHaveBeenCalled();
		fixture.virtualizer.range = { startIndex: 1, endIndex: 1 };
		fixture.virtualizer.scrollOffset = 810;
		fixture.viewport.dispatchEvent(new Event("scroll"));
		await waitFor(() => expect(fixture.work).toHaveBeenCalledTimes(1));
	} finally {
		fixture.unmount();
	}
});
test("paints visible pages immediately even during fast scrolling", () => {
	const fixture = setup(1);
	try {
		fixture.continueRender();
		expect(fixture.work).toHaveBeenCalledTimes(1);
	} finally {
		fixture.unmount();
	}
});
test("prewarms overscan after scrolling settles without another scroll event", async () => {
	const fixture = setup(2);
	try {
		fixture.continueRender();
		expect(fixture.work).not.toHaveBeenCalled();
		fixture.virtualizer.isScrolling = false;
		await waitFor(() => expect(fixture.work).toHaveBeenCalledTimes(1));
	} finally {
		fixture.unmount();
	}
});
test("cancels paused raster work on unmount", async () => {
	const fixture = setup(2);
	fixture.continueRender();
	fixture.unmount();
	fixture.virtualizer.isScrolling = false;
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(fixture.work).not.toHaveBeenCalled();
	expect(fixture.task.cancel).toHaveBeenCalled();
});

test.each([0.5, 0.6])(
	"paints the visible lower page at zoom %s despite virtualizer range estimates",
	(zoom) => {
		const fixture = setup(2, zoom);
		try {
			fixture.continueRender();
			expect(fixture.work).toHaveBeenCalledTimes(1);
		} finally {
			fixture.unmount();
		}
	},
);
