import type { PDFPageProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";

type PageText = { pageNumber: number; text: string };
type Job = {
	promise: Promise<PageText[]>;
	controller: AbortController;
	users: number;
	settled: boolean;
};
const jobs = new WeakMap<PDFPageProxy[], Job>();
const CONCURRENCY = 4;

/** Shared indexing with bounded PDF.js work; release when the consumer leaves. */
export function acquireDocumentText(pages: PDFPageProxy[]) {
	let job = jobs.get(pages);
	if (!job) {
		const controller = new AbortController();
		const { signal } = controller;
		let next = 0;
		const result: PageText[] = new Array(pages.length);
		const worker = async () => {
			while (next < pages.length) {
				signal.throwIfAborted();
				const index = next++;
				const page = pages[index]!;
				// Explicit reads work in WebKit without ReadableStream async iteration.
				// Retain strings only, instead of the whole page's position objects.
				const reader: ReadableStreamDefaultReader<TextContent> = page
					.streamTextContent()
					.getReader();
				const chunks: string[] = [];
				let complete = false;
				try {
					while (true) {
						const { value, done } = await reader.read();
						signal.throwIfAborted();
						if (done) {
							complete = true;
							break;
						}
						chunks.push(
							value.items
								.map((item) => ("str" in item ? item.str : ""))
								.join(""),
						);
					}
				} finally {
					// PDF.js requires an Error reason; worker acknowledgements must
					// not delay cancellation of the library's indexing job.
					if (!complete)
						void reader
							.cancel(new Error("Text indexing stopped"))
							.catch(() => {});
					reader.releaseLock();
				}
				result[index] = { pageNumber: page.pageNumber, text: chunks.join("") };
			}
		};
		const created: Job = {
			controller,
			users: 0,
			settled: false,
			promise: Promise.resolve([]),
		};
		created.promise = Promise.all(
			Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker),
		)
			.then(() => result)
			.catch((error) => {
				controller.abort();
				if (jobs.get(pages) === created) jobs.delete(pages);
				throw error;
			})
			.finally(() => {
				created.settled = true;
			});
		jobs.set(pages, created);
		job = created;
	}
	job.users++;
	const acquired = job;
	let released = false;
	return {
		promise: acquired.promise,
		release() {
			if (released) return;
			released = true;
			acquired.users--;
			// React Strict Mode immediately reattaches effects. Give that new
			// consumer a chance to reuse the job before cancelling it.
			queueMicrotask(() => {
				if (acquired.users || acquired.settled) return;
				if (jobs.get(pages) === acquired) jobs.delete(pages);
				acquired.controller.abort();
			});
		},
	};
}
