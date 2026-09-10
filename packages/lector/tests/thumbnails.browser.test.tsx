import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, test, vi } from "vitest";
import { Thumbnail, Thumbnails } from "../src/components/thumbnails";
import { wrapperFor } from "./helpers";

afterEach(cleanup);
test("1000-page thumbnail list can keep bounded DOM and reach the final page by keyboard", async () => {
	const pages = Array.from({ length: 1000 }, (_, i) => ({
		pageNumber: i + 1,
		getViewport: ({ scale }: { scale: number }) => ({
			width: 60 * scale,
			height: 80 * scale,
		}),
		render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
	})) as unknown as PDFPageProxy[];
	const start = performance.now();
	const view = render(
		<Thumbnails
			style={{ height: 450, width: 140 }}
			virtualize={{ itemHeight: 150, overscan: 2 }}
		>
			<Thumbnail style={{ height: 130, width: 100 }} />
		</Thumbnails>,
		{ wrapper: wrapperFor(pages) },
	);
	await waitFor(() =>
		expect(view.container.querySelector("canvas")).toBeTruthy(),
	);
	const dom = view.container.querySelectorAll("*").length;
	console.info(
		`AUDIT 1000-thumbnails: mountMs=${(performance.now() - start).toFixed(1)}, DOM=${dom}`,
	);
	expect(dom).toBeLessThan(60);
	const canvas = view.container.querySelector("canvas")!;
	canvas.focus();
	fireEvent.keyDown(canvas, { key: "End" });
	await waitFor(() =>
		expect(
			view.container.querySelector('[data-thumbnail-page="1000"] canvas'),
		).toBe(document.activeElement),
	);
	expect(view.container.querySelectorAll("*").length).toBeLessThan(60);
	fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
	await waitFor(() =>
		expect(
			view.container.querySelector('[data-thumbnail-page="999"] canvas'),
		).toBe(document.activeElement),
	);
	fireEvent.keyDown(document.activeElement!, { key: "Home" });
	await waitFor(() =>
		expect(
			view.container.querySelector('[data-thumbnail-page="1"] canvas'),
		).toBe(document.activeElement),
	);
});
