import type { PDFPageProxy } from "pdfjs-dist";
import { expect, test, vi } from "vitest";
import { acquireDocumentText } from "../src/lib/document-text";

function pagesWith(getTextContent: () => Promise<unknown>, count = 10) {
	return Array.from({ length: count }, (_, i) => ({
		pageNumber: i + 1,
		streamTextContent: () =>
			new ReadableStream({
				async start(controller) {
					try {
						controller.enqueue(await getTextContent());
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				},
			}),
	})) as unknown as PDFPageProxy[];
}

test("last consumer cancellation stops scheduling pages and permits a retry", async () => {
	let resolve!: (value: unknown) => void;
	const pending = new Promise((r) => {
		resolve = r;
	});
	const getText = vi.fn(() => pending);
	const pages = pagesWith(getText);
	const task = acquireDocumentText(pages);
	const rejected = expect(task.promise).rejects.toMatchObject({
		name: "AbortError",
	});
	expect(getText).toHaveBeenCalledTimes(4);
	task.release();
	await Promise.resolve();
	resolve({ items: [{ str: "hello" }] });
	await rejected;
	expect(getText).toHaveBeenCalledTimes(4);
	const retry = acquireDocumentText(pages);
	expect(await retry.promise).toHaveLength(10);
	retry.release();
});

test("Strict Mode release/reacquire shares the job; completed results are reused", async () => {
	const getText = vi.fn(async () => ({
		items: [{ str: "hello" }, { type: "beginMarkedContent" }, { str: "world" }],
	}));
	const pages = pagesWith(getText);
	const first = acquireDocumentText(pages);
	first.release();
	const second = acquireDocumentText(pages);
	expect(second.promise).toBe(first.promise);
	const text = await second.promise;
	expect(text.map((x) => x.pageNumber)).toEqual([
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
	]);
	expect(text[0]!.text).toBe("helloworld");
	second.release();
	const third = acquireDocumentText(pages);
	expect(await third.promise).toBe(text);
	expect(getText).toHaveBeenCalledTimes(10);
	third.release();
});

test("failed jobs are evicted so subsequent consumers can retry", async () => {
	const getText = vi
		.fn()
		.mockRejectedValueOnce(new Error("bad page"))
		.mockResolvedValue({ items: [] });
	const pages = pagesWith(getText, 1);
	const task = acquireDocumentText(pages);
	await expect(task.promise).rejects.toThrow("bad page");
	task.release();
	const retry = acquireDocumentText(pages);
	expect(await retry.promise).toEqual([{ pageNumber: 1, text: "" }]);
	retry.release();
});
