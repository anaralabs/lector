import { cleanup, render, waitFor } from "@testing-library/react";
import type {
	PageViewport,
	PDFDocumentProxy,
	PDFPageProxy,
	RenderTask,
} from "pdfjs-dist";
import { afterEach, expect, test, vi } from "vitest";
import {
	clearBitmapCache,
	useCanvasLayer,
} from "../src/hooks/layers/useCanvasLayer";
import { PDFPageNumberContext } from "../src/hooks/usePdfPageNumber";
import { PDFStore } from "../src/internal";

type RenderParameters = Parameters<PDFPageProxy["render"]>[0];

afterEach(() => {
	cleanup();
	clearBitmapCache();
	vi.restoreAllMocks();
});
function Canvas({ background }: { background?: string }) {
	const { canvasRef } = useCanvasLayer({ background });
	return <canvas ref={canvasRef} />;
}
function fixture() {
	let complete!: () => void;
	let calls = 0;
	const page = {
		pageNumber: 1,
		getViewport: ({ scale }: { scale: number }) => ({
			width: 200 * scale,
			height: 300 * scale,
		}),
		render: vi.fn((params: RenderParameters) => {
			const color = calls++ === 0 ? "rgb(255, 0, 0)" : "rgb(0, 0, 255)";
			let resolve!: () => void;
			const promise = new Promise<void>((yes) => {
				resolve = yes;
			});
			const paint = () => {
				const ctx = params.canvasContext!;
				ctx.fillStyle = color;
				ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
				resolve();
			};
			if (calls === 1) paint();
			else complete = paint;
			return { promise, cancel: () => resolve() } as RenderTask;
		}),
	} as unknown as PDFPageProxy;
	const document = {
		numPages: 1,
		fingerprints: ["preview"],
	} as PDFDocumentProxy;
	const mount = (zoom: number, background = "white", proxy = page) =>
		render(
			<PDFStore.Provider
				initialValue={{
					pdfDocumentProxy: document,
					pageProxies: [proxy],
					viewports: [{ width: 200, height: 300 }] as PageViewport[],
					zoom,
				}}
			>
				<PDFPageNumberContext.Provider value={1}>
					<Canvas background={background} />
				</PDFPageNumberContext.Provider>
			</PDFStore.Provider>,
		);
	return { page, mount, complete: () => complete() };
}

test.each([
	[1, 1.5],
	[1.5, 1],
])(
	"reuses cached pixels when revisiting at zoom %s → %s, then replaces them with the sharp render",
	async (before, after) => {
		const original = window.createImageBitmap.bind(window);
		const bitmap = vi
			.spyOn(window, "createImageBitmap")
			.mockImplementation(original);
		const { mount, page, complete } = fixture();
		const first = mount(before);
		await waitFor(() => expect(bitmap).toHaveBeenCalled());
		await bitmap.mock.results[0]!.value;
		await Promise.resolve();
		first.unmount();
		const next = mount(after);
		const canvas = next.container.querySelector("canvas")!;
		expect(page.render).toHaveBeenCalledTimes(2);
		expect(canvas.style.visibility).not.toBe("hidden");
		expect([
			...canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data,
		]).toEqual([255, 0, 0, 255]);
		complete();
		await waitFor(() =>
			expect([
				...canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data,
			]).toEqual([0, 0, 255, 255]),
		);
	},
);

test("does not use a cached preview with a different background", async () => {
	const bitmap = vi.spyOn(window, "createImageBitmap");
	const { mount } = fixture();
	const first = mount(1);
	await waitFor(() => expect(bitmap).toHaveBeenCalled());
	await bitmap.mock.results[0]!.value;
	await Promise.resolve();
	first.unmount();
	const next = mount(1.5, "black");
	expect(next.container.querySelector("canvas")!.style.visibility).toBe(
		"hidden",
	);
});

test("does not reuse another proxy's preview even when document fingerprints match", async () => {
	const bitmap = vi.spyOn(window, "createImageBitmap");
	const { mount, page } = fixture();
	const first = mount(1);
	await waitFor(() => expect(bitmap).toHaveBeenCalled());
	await bitmap.mock.results[0]!.value;
	await Promise.resolve();
	first.unmount();
	const next = mount(1.5, "white", {
		...page,
		pageNumber: page.pageNumber,
		getViewport: page.getViewport,
		render: page.render,
	} as PDFPageProxy);
	expect(next.container.querySelector("canvas")!.style.visibility).toBe(
		"hidden",
	);
});
