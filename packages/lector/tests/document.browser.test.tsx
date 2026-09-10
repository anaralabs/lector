import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, test, vi } from "vitest";
import { usePDFDocumentContext } from "../src/hooks/document/document";

const { tasks } = vi.hoisted(() => ({ tasks: new Map<string, any>() }));
vi.mock("../src/lib/pdfjs", () => ({
	getDefaultPdfJsAssetUrls: () => ({}),
	loadPdfJs: async () => ({
		version: "test",
		getDocument: ({ url }: { url: string }) => tasks.get(url),
	}),
}));
afterEach(() => {
	cleanup();
	tasks.clear();
});

function taskFor(source: string, getPage: () => Promise<PDFPageProxy>) {
	const proxy = { numPages: 1, getPage, fingerprints: [source] };
	const task = {
		promise: Promise.resolve(proxy),
		destroyed: false,
		destroy: vi.fn(async () => {
			task.destroyed = true;
		}),
		onProgress: undefined as
			| undefined
			| ((event: { loaded: number; total: number }) => void),
	};
	tasks.set(source, task);
	return task;
}
const page = {
	pageNumber: 1,
	rotate: 0,
	getViewport: () => ({ width: 600, height: 800 }),
} as unknown as PDFPageProxy;

test("download progress does not rerender an unconsumed progress value", async () => {
	const task = taskFor("a", () => new Promise(() => {}));
	let renders = 0;
	renderHook(() => {
		renders++;
		return usePDFDocumentContext({ source: "a" });
	});
	await waitFor(() => expect(tasks.get("a").promise).toBeTruthy());
	await act(async () => {
		await Promise.resolve();
	});
	const before = renders;
	for (let i = 1; i <= 50; i++)
		act(() => task.onProgress?.({ loaded: i, total: 100 }));
	console.info(`PERF 50-download-progress-events: renders=${renders - before}`);
	expect(renders - before).toBe(0);
});

test("a disposed document cannot publish viewports after its replacement loads", async () => {
	let resolveOld!: (value: PDFPageProxy) => void;
	const oldPage = new Promise<PDFPageProxy>((resolve) => {
		resolveOld = resolve;
	});
	const getOldPage = vi.fn(() => oldPage);
	taskFor("a", getOldPage);
	const next = taskFor("b", async () => page);
	const { result, rerender } = renderHook(
		({ source }) => usePDFDocumentContext({ source }),
		{ initialProps: { source: "a" } },
	);
	await waitFor(() => expect(getOldPage).toHaveBeenCalled());
	rerender({ source: "b" });
	const nextProxy = await next.promise;
	await waitFor(() =>
		expect(result.current.initialState?.pdfDocumentProxy).toBe(nextProxy),
	);
	await act(async () => {
		resolveOld(page);
		await oldPage;
	});
	expect(result.current.initialState?.pdfDocumentProxy).toBe(
		await next.promise,
	);
});
