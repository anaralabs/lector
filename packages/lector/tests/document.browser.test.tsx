import {
	act,
	cleanup,
	render,
	renderHook,
	waitFor,
} from "@testing-library/react";
import type { PDFPageProxy } from "pdfjs-dist";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Root } from "../src/components/root";
import { usePDFDocumentContext } from "../src/hooks/document/document";

const { tasks, workers, workerOptions } = vi.hoisted(() => ({
	tasks: new Map<string, any>(),
	workers: [] as any[],
	workerOptions: { workerPort: null as unknown, workerSrc: "worker.js" },
}));
vi.mock("../src/lib/pdfjs", () => {
	class Worker {
		destroyed = false;
		promise = Promise.resolve();
		destroy = vi.fn(() => {
			this.destroyed = true;
		});
		constructor() {
			workers.push(this);
		}
	}
	return {
		getDefaultPdfJsAssetUrls: () => ({}),
		loadPdfJs: async () => ({
			version: "test",
			PDFWorker: Worker,
			GlobalWorkerOptions: workerOptions,
			getDocument: ({ url, worker }: { url: string; worker?: Worker }) => {
				const task = tasks.get(url);
				task.suppliedWorker = worker;
				task.worker = worker ?? new Worker();
				if (!worker) {
					const destroy = task.destroy.getMockImplementation();
					task.destroy.mockImplementation(async () => {
						await destroy();
						task.worker.destroy();
					});
				}
				return task;
			},
		}),
	};
});
afterEach(() => {
	cleanup();
	tasks.clear();
	workers.length = 0;
	workerOptions.workerPort = null;
	workerOptions.workerSrc = "worker.js";
});

function taskFor(source: string, getPage: () => Promise<PDFPageProxy>) {
	const proxy = { numPages: 1, getPage, fingerprints: [source] };
	const task = {
		promise: Promise.resolve(proxy),
		destroyed: false,
		worker: undefined as any,
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

test("a failed document replaces the loading message with an accessible error", async () => {
	const error = new Error("Download failed");
	const task = taskFor("failed", async () => page);
	task.promise = Promise.reject(error);
	const onError = vi.fn();
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const view = render(
			<Root
				source="failed"
				loader={<span>Opening document</span>}
				onError={onError}
			>
				<span>Ready</span>
			</Root>,
		);
		await waitFor(() => expect(onError).toHaveBeenCalled());
		expect(view.queryByText("Opening document")).toBeNull();
		expect(view.getByRole("alert").textContent).toContain("Unable to load");
	} finally {
		log.mockRestore();
	}
});

test("download progress uses the latest callback and ignores a replaced document", async () => {
	const old = taskFor("old", () => new Promise(() => {}));
	taskFor("next", () => new Promise(() => {}));
	const firstCallback = vi.fn(),
		nextCallback = vi.fn();
	const { rerender } = renderHook(
		({ source, callback }) =>
			usePDFDocumentContext({ source, onDocumentProgress: callback }),
		{ initialProps: { source: "old", callback: firstCallback } },
	);
	await waitFor(() => expect(old.onProgress).toBeTypeOf("function"));
	old.onProgress!({ loaded: 10, total: 100 });
	expect(firstCallback).toHaveBeenLastCalledWith({
		loaded: 10,
		total: 100,
		source: "old",
	});
	rerender({ source: "old", callback: nextCallback });
	old.onProgress!({ loaded: 20, total: 100 });
	expect(nextCallback).toHaveBeenCalledTimes(1);
	rerender({ source: "next", callback: nextCallback });
	expect(old.destroy).toHaveBeenCalledTimes(1);
	old.onProgress!({ loaded: 100, total: 100 });
	expect(nextCallback).toHaveBeenCalledTimes(1);
});

test("custom loading errors are scoped to their source and disappear on replacement", async () => {
	const failed = taskFor("bad", async () => page);
	failed.promise = Promise.reject(new Error("Network failure"));
	taskFor("good", async () => page);
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const fallback = vi.fn(({ phase }: { phase: string }) => (
		<div role="alert">Custom {phase}</div>
	));
	try {
		const view = render(
			<Root source="bad" errorFallback={fallback}>
				<span>Reader ready</span>
			</Root>,
		);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toBe("Custom document-load"),
		);
		view.rerender(
			<Root source="good" errorFallback={fallback}>
				<span>Reader ready</span>
			</Root>,
		);
		expect(view.queryByRole("alert")).toBeNull();
		await waitFor(() => expect(view.getByText("Reader ready")).toBeTruthy());
		expect(fallback).toHaveBeenCalledWith(
			expect.objectContaining({ source: "bad", phase: "document-load" }),
		);
	} finally {
		log.mockRestore();
	}
});

test("a source replacement hides the old document before layout effects", async () => {
	const old = taskFor("old-ready", async () => page);
	taskFor("pending", () => new Promise(() => {}));
	const snapshots: unknown[] = [];
	const { result, rerender } = renderHook(
		({ source }) => {
			const value = usePDFDocumentContext({ source });
			useLayoutEffect(() => {
				snapshots.push({
					source,
					document: value.initialState?.pdfDocumentProxy ?? null,
				});
			}, [source, value.initialState]);
			return value;
		},
		{ initialProps: { source: "old-ready" } },
	);
	await waitFor(() =>
		expect(result.current.initialState?.pdfDocumentProxy).toBeTruthy(),
	);
	snapshots.length = 0;
	rerender({ source: "pending" });
	expect(snapshots).toEqual([{ source: "pending", document: null }]);
	expect(old.destroy).toHaveBeenCalledTimes(1);
});

test("reuses the reader-owned worker across source changes and destroys it after document cleanup", async () => {
	const old = taskFor("worker-old", () => new Promise(() => {}));
	const next = taskFor("worker-next", () => new Promise(() => {}));
	let finishCleanup!: () => void;
	const pending = new Promise<void>((resolve) => {
		finishCleanup = resolve;
	});
	next.destroy.mockImplementation(() => pending);
	const { rerender, unmount } = renderHook(
		({ source }) => usePDFDocumentContext({ source }),
		{ initialProps: { source: "worker-old" } },
	);
	await waitFor(() => expect(old.worker).toBeTruthy());
	const worker = old.worker;
	rerender({ source: "worker-next" });
	await waitFor(() => expect(next.worker).toBeTruthy());
	try {
		expect(next.worker).toBe(worker);
		expect(old.destroy).toHaveBeenCalledTimes(1);
		expect(worker.destroy).not.toHaveBeenCalled();
		unmount();
		expect(next.destroy).toHaveBeenCalledTimes(1);
		expect(worker.destroy).not.toHaveBeenCalled();
	} finally {
		finishCleanup();
	}
	await waitFor(() => expect(worker.destroy).toHaveBeenCalledTimes(1));
});

test("leaves caller-supplied worker ownership unchanged", async () => {
	const task = taskFor("custom-worker", () => new Promise(() => {}));
	const worker = { promise: Promise.resolve(), destroy: vi.fn() };
	const { unmount } = renderHook(() =>
		usePDFDocumentContext({
			source: "custom-worker",
			documentOptions: { worker: worker as never },
		}),
	);
	await waitFor(() => expect(task.worker).toBe(worker));
	unmount();
	expect(task.destroy).toHaveBeenCalledTimes(1);
	expect(worker.destroy).not.toHaveBeenCalled();
	expect(workers).toHaveLength(0);
});

test("recreates the owned worker when its configured script changes", async () => {
	const old = taskFor("script-old", () => new Promise(() => {}));
	const next = taskFor("script-next", () => new Promise(() => {}));
	const { rerender, unmount } = renderHook(
		({ source }) => usePDFDocumentContext({ source }),
		{ initialProps: { source: "script-old" } },
	);
	await waitFor(() => expect(old.worker).toBeTruthy());
	workerOptions.workerSrc = "replacement-worker.js";
	rerender({ source: "script-next" });
	await waitFor(() => expect(next.worker).toBeTruthy());
	expect(next.worker).not.toBe(old.worker);
	await waitFor(() => expect(old.worker.destroy).toHaveBeenCalledTimes(1));
	unmount();
	await waitFor(() => expect(next.worker.destroy).toHaveBeenCalledTimes(1));
});

test("delegates globally supplied ports to PDF.js", async () => {
	workerOptions.workerPort = {};
	const task = taskFor("global-port", () => new Promise(() => {}));
	const { unmount } = renderHook(() =>
		usePDFDocumentContext({ source: "global-port" }),
	);
	await waitFor(() => expect(task.worker).toBeTruthy());
	expect(tasks.get("global-port").suppliedWorker).toBeUndefined();
	unmount();
	await waitFor(() => expect(task.worker.destroy).toHaveBeenCalledTimes(1));
});

test("Strict Mode leaves no reader-owned worker after unmount", async () => {
	const task = taskFor("strict-worker", () => new Promise(() => {}));
	const { unmount } = renderHook(
		() => usePDFDocumentContext({ source: "strict-worker" }),
		{
			wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
		},
	);
	await waitFor(() => expect(task.worker).toBeTruthy());
	expect(task.worker.destroyed).toBe(false);
	unmount();
	await waitFor(() =>
		expect(workers.every((worker) => worker.destroyed)).toBe(true),
	);
});
