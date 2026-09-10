import { act, cleanup, render } from "@testing-library/react";
import type { PageViewport, PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, test } from "vitest";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { PDFStore } from "../src/internal";
import { wrapperFor } from "./helpers";

afterEach(cleanup);

test("page width is not rescanned on every unrelated store update", async () => {
	const pages = Array.from({ length: 1000 }, (_, i) => ({
		pageNumber: i + 1,
	})) as PDFPageProxy[];
	let store!: ReturnType<typeof PDFStore.useContext>;
	function Probe() {
		store = PDFStore.useContext();
		return null;
	}
	render(
		<>
			<Probe />
			<Pages style={{ height: 600, width: 800 }}>
				<Page>
					<div />
				</Page>
			</Pages>
		</>,
		{ wrapper: wrapperFor(pages) },
	);
	let reads = 0;
	const viewports = pages.map(() => ({
		height: 800,
		get width() {
			reads++;
			return 600;
		},
	})) as PageViewport[];
	act(() => store.setState({ viewports }));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	reads = 0;
	act(() => {
		for (let i = 0; i < 100; i++) store.getState().setCurrentPage((i % 2) + 1);
	});
	console.info(`PERF 1000-page-widths-100-updates: width-reads=${reads}`);
	expect(reads).toBeLessThan(1000);
});
