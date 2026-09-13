import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import type { PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, test, vi } from "vitest";
import { Thumbnail, Thumbnails } from "../src/components/thumbnails";
import { PDFStore, type PDFVirtualizer } from "../src/internal";
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

test("thumbnails expose page labels/current state and support cancellable button keyboard behavior", async () => {
	const page = {
		pageNumber: 1,
		getViewport: ({ scale }: { scale: number }) => ({
			width: 60 * scale,
			height: 80 * scale,
		}),
		render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
	} as unknown as PDFPageProxy;
	let store!: ReturnType<typeof PDFStore.useContext>;
	function Probe() {
		store = PDFStore.useContext();
		return null;
	}
	const click = vi.fn();
	const keyDown = vi.fn();
	const view = render(
		<>
			<Probe />
			<Thumbnail onClick={click} onKeyDown={keyDown} />
		</>,
		{ wrapper: wrapperFor([page]) },
	);
	const scrollToIndex = vi.fn();
	act(() =>
		store
			.getState()
			.setVirtualizer({ scrollToIndex } as unknown as PDFVirtualizer),
	);
	const button = view.getByRole("button", { name: "Page 1" });
	expect(button.getAttribute("aria-current")).toBe("page");
	act(() => store.getState().setCurrentPage(2));
	expect(button.hasAttribute("aria-current")).toBe(false);
	button.focus();
	expect(fireEvent.keyDown(button, { key: " " })).toBe(false);
	expect(scrollToIndex).not.toHaveBeenCalled();
	fireEvent.keyUp(button, { key: " " });
	expect(scrollToIndex).toHaveBeenCalledTimes(1);
	fireEvent.keyDown(button, { key: "Enter" });
	expect(scrollToIndex).toHaveBeenCalledTimes(2);
	keyDown.mockImplementationOnce((event) => event.preventDefault());
	fireEvent.keyDown(button, { key: "Enter" });
	click.mockImplementationOnce((event) => event.preventDefault());
	fireEvent.click(button);
	expect(scrollToIndex).toHaveBeenCalledTimes(2);
	fireEvent.keyDown(button, { key: " " });
	fireEvent.blur(button);
	fireEvent.keyUp(button, { key: " " });
	expect(scrollToIndex).toHaveBeenCalledTimes(2);
});
