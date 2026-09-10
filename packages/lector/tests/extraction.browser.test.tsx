import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, test, vi } from "vitest";
import { Search } from "../src/components/search";
import { usePdf } from "../src/internal";
import { wrapperFor } from "./helpers";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
test("two Search consumers share extraction with bounded PDF.js concurrency", async () => {
	let active = 0,
		peak = 0,
		calls = 0;
	const pages = Array.from({ length: 100 }, (_, i) => ({
		pageNumber: i + 1,
		streamTextContent: vi.fn(
			() =>
				new ReadableStream({
					async start(controller) {
						calls++;
						peak = Math.max(peak, ++active);
						await new Promise((resolve) => setTimeout(resolve, 1));
						active--;
						controller.enqueue({ items: [{ str: `page ${i + 1}` }] });
						controller.close();
					},
				}),
		),
	})) as unknown as PDFPageProxy[];
	const view = render(
		<>
			<Search>
				<span>first done</span>
			</Search>
			<Search>
				<span>second done</span>
			</Search>
		</>,
		{ wrapper: wrapperFor(pages) },
	);
	await waitFor(() => expect(view.getByText("second done")).toBeTruthy());
	console.info(
		`PERF 100-page-text-index: calls=${calls}, peak-concurrency=${peak}`,
	);
	expect(calls).toBe(100);
	expect(peak).toBeLessThanOrEqual(4);
});

test("failed indexing does not mount a ready-looking search UI", async () => {
	const error = new Error("text extraction failed");
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const pages = [
		{
			pageNumber: 1,
			streamTextContent: () =>
				new ReadableStream({
					start(controller) {
						controller.error(error);
					},
				}),
		},
	] as unknown as PDFPageProxy[];
	const view = render(
		<Search>
			<span>Search ready</span>
		</Search>,
		{ wrapper: wrapperFor(pages) },
	);
	await waitFor(() => expect(logged).toHaveBeenCalled());
	expect(view.queryByText("Search ready")).toBeNull();
	expect(view.getByRole("alert").textContent).toContain("Unable to index");
});

function IndexedText() {
	const text = usePdf((state) => state.textContent);
	return <span>Indexed: {text.map((page) => page.text).join(" ")}</span>;
}

test("retry recovers a failed index without remounting the viewer", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	let finish!: () => void;
	const stream = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new ReadableStream({
					start(controller) {
						controller.error(new Error("failed once"));
					},
				}),
		)
		.mockImplementation(
			() =>
				new ReadableStream({
					start(controller) {
						finish = () => {
							controller.enqueue({ items: [{ str: "Recovered text" }] });
							controller.close();
						};
					},
				}),
		);
	const pages = [
		{ pageNumber: 1, streamTextContent: stream },
	] as unknown as PDFPageProxy[];
	const view = render(
		<Search>
			<IndexedText />
		</Search>,
		{ wrapper: wrapperFor(pages) },
	);
	const retry = await view.findByRole("button", { name: "Retry" });
	fireEvent.click(retry);
	await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
	expect(view.getByText("Loading...")).toBeTruthy();
	expect(view.queryByText(/Indexed:/)).toBeNull();
	finish();
	expect(await view.findByText("Indexed: Recovered text")).toBeTruthy();
	expect(view.queryByRole("alert")).toBeNull();
});

test("custom error fallback receives the cause and can retry persistent failures", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const error = new Error("unreadable page");
	const stream = vi.fn(
		() =>
			new ReadableStream({
				start(controller) {
					controller.error(error);
				},
			}),
	);
	const pages = [
		{ pageNumber: 1, streamTextContent: stream },
	] as unknown as PDFPageProxy[];
	const fallback = vi.fn(({ retry }: { error: unknown; retry: () => void }) => (
		<button onClick={retry}>Try indexing again</button>
	));
	const view = render(
		<Search errorFallback={fallback}>
			<span>Search ready</span>
		</Search>,
		{ wrapper: wrapperFor(pages) },
	);
	fireEvent.click(
		await view.findByRole("button", { name: "Try indexing again" }),
	);
	await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
	await view.findByRole("button", { name: "Try indexing again" });
	expect(fallback.mock.calls.at(-1)?.[0].error).toBe(error);
	expect(view.queryByText("Search ready")).toBeNull();
});
