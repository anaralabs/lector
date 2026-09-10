import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { expect, test, vi } from "vitest";
import { PageResources } from "../src/lib/page-resources";

function page(number: number, width = 600, height = 800, rotate = 0) {
	return {
		pageNumber: number,
		rotate,
		getViewport: ({ rotation }: { rotation: number }) =>
			rotation % 180
				? { width: height, height: width, rotation }
				: { width, height, rotation },
	} as unknown as PDFPageProxy;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("mount-time snapshot needs only the requested initial page and correct rotation", () => {
	const getPage = vi.fn();
	const resources = new PageResources(
		{ numPages: 1000, getPage } as unknown as PDFDocumentProxy,
		page(700, 500, 900, 90),
		0,
		vi.fn(),
	);
	expect(getPage).not.toHaveBeenCalled();
	expect(resources.get(700)?.pageNumber).toBe(700);
	expect(resources.get(1)).toBeUndefined();
	expect(resources.getSnapshot().viewports).toHaveLength(1000);
	expect(resources.getSnapshot().viewports[0]).toMatchObject({
		width: 900,
		height: 500,
	});
	resources.dispose();
});

test("bounds requests, shares pending work and moves a visible page ahead of background pages", async () => {
	const requests = new Map<number, ReturnType<typeof deferred<PDFPageProxy>>>();
	const getPage = vi.fn((number: number) => {
		const task = deferred<PDFPageProxy>();
		requests.set(number, task);
		return task.promise;
	});
	const resources = new PageResources(
		{ numPages: 100, getPage } as unknown as PDFDocumentProxy,
		page(1),
		0,
		vi.fn(),
		2,
	);
	resources.start();
	await tick();
	expect(getPage.mock.calls.map(([number]) => number)).toEqual([2, 3]);
	const wanted = resources.load(90);
	expect(resources.load(90)).toBe(wanted);
	requests.get(2)!.resolve(page(2));
	await tick();
	expect(getPage.mock.calls.map(([number]) => number)).toEqual([2, 3, 90]);
	requests.get(90)!.resolve(page(90, 900, 500));
	await expect(wanted).resolves.toMatchObject({ pageNumber: 90 });
	await tick();
	expect(resources.getSnapshot().viewports[89]).toMatchObject({
		width: 900,
		height: 500,
	});
	resources.dispose();
});

test("completes with one ordered array, preserving estimates until batched notification", async () => {
	const resources = new PageResources(
		{
			numPages: 3,
			getPage: async (number: number) =>
				page(number, 400 + number, 700 + number, number === 2 ? 90 : 0),
		} as unknown as PDFDocumentProxy,
		page(1),
		0,
		vi.fn(),
	);
	const initial = resources.getSnapshot().viewports;
	const notify = vi.fn();
	resources.subscribe(notify);
	const [first, second] = await Promise.all([
		resources.loadAll(),
		resources.loadAll(),
	]);
	expect(first).toBe(second);
	expect(first.map((item) => item.pageNumber)).toEqual([1, 2, 3]);
	await tick();
	expect(notify).toHaveBeenCalledTimes(1);
	expect(initial[1]).toMatchObject({ width: 600, height: 800 });
	expect(resources.getSnapshot().viewports[1]).toMatchObject({
		width: 702,
		height: 402,
	});
	resources.dispose();
});

test("failed page requests can be retried without discarding successful resources", async () => {
	const error = new Error("bad page");
	const getPage = vi
		.fn()
		.mockRejectedValueOnce(error)
		.mockResolvedValue(page(2));
	const onError = vi.fn();
	const resources = new PageResources(
		{ numPages: 2, getPage } as unknown as PDFDocumentProxy,
		page(1),
		0,
		onError,
	);
	await expect(resources.loadAll()).rejects.toBe(error);
	await expect(resources.loadAll()).resolves.toHaveLength(2);
	expect(getPage).toHaveBeenCalledTimes(2);
	expect(onError).toHaveBeenCalledWith(error);
	resources.dispose();
});

test("disposal rejects waiters, prevents queued requests and ignores late completion", async () => {
	const pending = deferred<PDFPageProxy>();
	const getPage = vi.fn(() => pending.promise);
	const resources = new PageResources(
		{ numPages: 20, getPage } as unknown as PDFDocumentProxy,
		page(1),
		0,
		vi.fn(),
		1,
	);
	const notify = vi.fn();
	resources.subscribe(notify);
	const all = resources.loadAll();
	const rejection = expect(all).rejects.toThrow("cancelled");
	await tick();
	resources.dispose();
	await rejection;
	pending.resolve(page(2));
	await tick();
	expect(getPage).toHaveBeenCalledTimes(1);
	expect(resources.get(2)).toBeUndefined();
	expect(notify).not.toHaveBeenCalled();
	await expect(resources.load(3)).rejects.toThrow("cancelled");
});
