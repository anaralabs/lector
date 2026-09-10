import { cleanup, render, waitFor } from "@testing-library/react";
import type { PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, test, vi } from "vitest";
import { Search } from "../src/components/search";
import { wrapperFor } from "./helpers";

afterEach(cleanup);
test("two Search consumers share extraction with bounded PDF.js concurrency", async () => {
	let active = 0,
		peak = 0,
		calls = 0;
	const pages = Array.from({ length: 100 }, (_, i) => ({
		pageNumber: i + 1,
		getTextContent: vi.fn(async () => {
			calls++;
			peak = Math.max(peak, ++active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
			return { items: [{ str: `page ${i + 1}` }] };
		}),
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
