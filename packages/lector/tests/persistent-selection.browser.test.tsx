import { act, cleanup, render, waitFor } from "@testing-library/react";
import { commands, userEvent } from "@vitest/browser/context";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { usePdfSelection } from "../src/hooks/usePdfSelection";
import { useSelectionDimensions } from "../src/hooks/useSelectionDimensions";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";
import { createTextGeometryPdf } from "./fixtures/text-geometry";

afterEach(() => {
	cleanup();
	document.getSelection()?.removeAllRanges();
});

test("a real PDF selection survives page eviction and returns when scrolled back", async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	let store!: ReturnType<typeof PDFStore.useContext>;
	let dimensions!: ReturnType<typeof useSelectionDimensions>;
	function Probe() {
		store = PDFStore.useContext();
		dimensions = useSelectionDimensions();
		return null;
	}
	const view = render(
		<Root
			source={{ data: createTextPdf(20, 3) }}
			style={{ height: 500, width: 700 }}
		>
			<Probe />
			<Pages virtualizerOptions={{ overscan: 0 }}>
				<Page>
					<TextLayer />
				</Page>
			</Pages>
		</Root>,
	);
	const page = (number: number) =>
		view.container.querySelector<HTMLElement>(
			`.textLayer[data-page-number="${number}"]`,
		);
	await waitFor(
		() => expect(page(1)?.querySelector("span")?.firstChild).toBeTruthy(),
		{ timeout: 15000 },
	);
	const text = page(1)!.querySelector("span")!.firstChild!;
	const selection = document.getSelection()!;
	selection.setBaseAndExtent(text, 0, text, 14);
	document.dispatchEvent(new Event("selectionchange"));
	expect(dimensions.getText()).toBe("Page 1 line 1:");
	const viewport = store.getState().viewportRef.current!;
	act(() => {
		viewport.scrollTop = 802 * 10;
		viewport.dispatchEvent(new Event("scroll"));
	});
	await waitFor(() => expect(page(1)).toBeNull());
	await waitFor(() => expect(page(11)?.querySelector("span")).toBeTruthy(), {
		timeout: 15000,
	});
	expect(dimensions.getText()).toBe("Page 1 line 1:");
	expect(view.container.querySelectorAll(".textLayer").length).toBeLessThan(5);
	act(() => {
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new Event("scroll"));
	});
	await waitFor(() => expect(page(1)?.querySelector("span")).toBeTruthy(), {
		timeout: 15000,
	});
	await waitFor(() =>
		expect(document.getSelection()?.toString()).toBe("Page 1 line 1:"),
	);
}, 20000);

async function reader(data = createTextPdf(20, 30)) {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	let store!: ReturnType<typeof PDFStore.useContext>;
	let api!: ReturnType<typeof usePdfSelection>;
	function Probe() {
		store = PDFStore.useContext();
		api = usePdfSelection();
		return null;
	}
	const view = render(
		<Root source={{ data }} style={{ height: 500, width: 700 }}>
			<Probe />
			<Pages virtualizerOptions={{ overscan: 0 }}>
				<Page>
					<TextLayer />
				</Page>
			</Pages>
		</Root>,
	);
	const page = (number: number) =>
		view.container.querySelector<HTMLElement>(
			`.textLayer[data-page-number="${number}"]`,
		);
	await waitFor(
		() => expect(page(1)?.querySelector("span")?.firstChild).toBeTruthy(),
		{ timeout: 15000 },
	);
	return {
		view,
		page,
		get api() {
			return api;
		},
		get viewport() {
			return store.getState().viewportRef.current!;
		},
	};
}

test("includes unmounted intermediate pages in copied text and precise geometry", async () => {
	const r = await reader(createTextPdf(20, 3));
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 5 },
			{ pageNumber: 10, offset: 15 },
		),
	);
	let result!: Awaited<ReturnType<typeof r.api.getSelectionAsync>>;
	await act(async () => {
		result = await r.api.getSelectionAsync();
	});
	expect(result!.text).toMatch(/^1 line 1:/);
	expect(result!.text).toContain("Page 5 line 2:");
	expect(result!.text).toMatch(/Page 10 line 1:$/);
	expect(new Set(result!.highlights.map((rect) => rect.pageNumber)).size).toBe(
		10,
	);
	expect(
		result!.highlights.every(
			(rect) =>
				rect.width > 0 &&
				rect.width < 500 &&
				rect.height > 0 &&
				rect.height < 30,
		),
	).toBe(true);
	expect(r.view.container.querySelectorAll(".textLayer").length).toBeLessThan(
		5,
	);
	expect(
		document.querySelectorAll('.textLayer[aria-hidden="true"]').length,
	).toBe(0);
	const data = new Map<string, string>();
	const event = new Event("copy", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: { setData: (type: string, text: string) => data.set(type, text) },
	});
	r.viewport.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(true);
	expect(data.get("text/plain")).toBe(result!.text);
	act(() => r.api.clearSelection());
	expect(r.api.getSelection()).toBeNull();
});

test("a real mouse drag autoscrolls past an evicted anchor page", async () => {
	const r = await reader();
	const text = r.page(1)!.querySelector("span")!.getBoundingClientRect();
	const viewport = r.viewport.getBoundingClientRect();
	await commands.selectionPointer(
		"down",
		text.left + 1,
		text.top + text.height / 2,
	);
	await commands.selectionPointer("move", text.left + 180, viewport.bottom - 2);
	try {
		await waitFor(
			() => expect(r.api.selection?.focus.pageNumber).toBeGreaterThanOrEqual(3),
			{ timeout: 15000 },
		);
	} finally {
		await commands.selectionPointer("up", 0, 0);
	}
	expect(r.api.selection?.anchor.pageNumber).toBe(1);
	expect(r.page(1)).toBeNull();
	await act(async () => {
		await r.api.getSelectionAsync();
	});
	expect(r.api.getText()).toContain("1 line 1:");
	expect(r.api.getText()).toContain("Page 2 line 30:");
	expect(r.view.container.querySelectorAll(".textLayer").length).toBeLessThan(
		5,
	);
}, 20000);

test("native double-click keeps word selection", async () => {
	const r = await reader();
	const span = r.page(1)!.querySelector("span")!;
	await userEvent.dblClick(span, { position: { x: 8, y: 5 } });
	await waitFor(() => expect(r.api.getText()?.trim()).toBe("Page"));
});

let stylesheet: HTMLLinkElement;
beforeAll(async () => {
	stylesheet = document.createElement("link");
	stylesheet.rel = "stylesheet";
	stylesheet.href = new URL(
		"../node_modules/pdfjs-dist/web/pdf_viewer.css",
		import.meta.url,
	).href;
	await new Promise<void>((resolve, reject) => {
		stylesheet.onload = () => resolve();
		stylesheet.onerror = () => reject(new Error("Stylesheet failed"));
		document.head.append(stylesheet);
	});
});
afterAll(() => stylesheet?.remove());

test("keyboard extension restores an offscreen focus without losing its anchor", async () => {
	const r = await reader();
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: 4 },
		),
	);
	act(() => {
		r.viewport.scrollTop = 802 * 10;
		r.viewport.dispatchEvent(new Event("scroll"));
	});
	await waitFor(() => expect(r.page(1)).toBeNull());
	await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
	await waitFor(
		() => expect(r.api.selection?.focus).toEqual({ pageNumber: 1, offset: 5 }),
		{ timeout: 15000 },
	);
	expect(r.api.selection?.anchor).toEqual({ pageNumber: 1, offset: 0 });
	expect(r.page(1)).not.toBeNull();
	await userEvent.keyboard("{Escape}");
	await waitFor(() => expect(r.api.selection).toBeNull());
});

test.each([90, 180, 270])(
	"rotated page %s geometry matches mounted and offscreen text",
	async (rotation) => {
		const data = createTextPdf(2, 3, [
			{ width: 612, height: 792, rotation },
			{ width: 612, height: 792, rotation },
		]);
		const r = await reader(data);
		act(() =>
			r.api.setSelection(
				{ pageNumber: 1, offset: 0 },
				{ pageNumber: 1, offset: 14 },
			),
		);
		const a = r.api.getSelection()!.highlights[0]!;
		act(() =>
			r.api.setSelection(
				{ pageNumber: 2, offset: 0 },
				{ pageNumber: 2, offset: 14 },
			),
		);
		let result!: Awaited<ReturnType<typeof r.api.getSelectionAsync>>;
		await act(async () => {
			result = await r.api.getSelectionAsync();
		});
		const b = result!.highlights.find((rect) => rect.pageNumber === 2)!;
		expect(b.left).toBeCloseTo(a.left, 0);
		expect(b.top).toBeCloseTo(a.top, 0);
		expect(b.width > 0 && b.height > 0).toBe(true);
	},
);

test("reverse drag survives eviction and preserves selection direction", async () => {
	const r = await reader();
	act(() => {
		r.viewport.scrollTop = 802 * 3;
		r.viewport.dispatchEvent(new Event("scroll"));
	});
	await waitFor(() => expect(r.page(4)?.querySelector("span")).toBeTruthy(), {
		timeout: 15000,
	});
	const text = r.page(4)!.querySelector("span")!.getBoundingClientRect();
	const viewport = r.viewport.getBoundingClientRect();
	await commands.selectionPointer(
		"down",
		text.left + 120,
		text.top + text.height / 2,
	);
	await commands.selectionPointer("move", text.left + 20, viewport.top + 1);
	try {
		await waitFor(() => expect(r.api.selection?.focus.pageNumber).toBe(1), {
			timeout: 15000,
		});
	} finally {
		await commands.selectionPointer("up", 0, 0);
	}
	expect(r.api.selection?.anchor.pageNumber).toBe(4);
	await act(async () => {
		await r.api.getSelectionAsync();
	});
	expect(r.api.getText()).toContain("Page 2 line 1:");
	expect(r.page(4)).toBeNull();
}, 20000);

test("clearing or replacing a loading selection cancels its stale result", async () => {
	const r = await reader();
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 20, offset: 20 },
		),
	);
	const pending = r.api.getSelectionAsync();
	const assertion = expect(pending).rejects.toMatchObject({
		name: "AbortError",
	});
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: 4 },
		),
	);
	await assertion;
	expect(r.api.getText()).toBe("Page");
	await waitFor(() =>
		expect(
			document.querySelectorAll('.textLayer[aria-hidden="true"]').length,
		).toBe(0),
	);
});

test("selection remains available to toolbar actions but does not capture form input", async () => {
	const r = await reader();
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: 4 },
		),
	);
	let copied: string | null = null;
	const toolbar = render(
		<>
			<button
				type="button"
				onClick={() => {
					copied = r.api.getText();
				}}
			>
				Save quote
			</button>
			<input aria-label="Notes" />
		</>,
	);
	await userEvent.click(toolbar.getByText("Save quote"));
	expect(copied).toBe("Page");
	const input = toolbar.getByLabelText("Notes");
	await userEvent.fill(input, "My notes");
	await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
	expect((input as HTMLInputElement).selectionStart).toBe(7);
	expect(r.api.selection).toBeNull();
});

test("partial proportional-font selection follows glyph widths and never spans a column gutter", async () => {
	const r = await reader(
		createTextGeometryPdf({
			operators:
				"BT /F1 20 Tf 1 0 0 1 50 700 Tm (iiiiWWWW) Tj 1 0 0 1 350 700 Tm (Column two) Tj ET",
		}),
	);
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: 4 },
		),
	);
	const narrow = r.api.getSelection()!.highlights[0]!;
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 4 },
			{ pageNumber: 1, offset: 8 },
		),
	);
	const wide = r.api.getSelection()!.highlights[0]!;
	expect(wide.width).toBeGreaterThan(narrow.width * 2);
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: r.page(1)!.textContent!.length },
		),
	);
	const rects = r.api.getSelection()!.highlights;
	expect(rects.length).toBeGreaterThanOrEqual(2);
	expect(rects.every((rect) => rect.width < 200)).toBe(true);
	expect(rects.some((rect) => rect.left < 100)).toBe(true);
	expect(rects.some((rect) => rect.left > 300)).toBe(true);
});

test("programmatic selection ownership transfers between viewers", async () => {
	const first = await reader(createTextPdf(2, 3));
	act(() =>
		first.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: 4 },
		),
	);
	const second = await reader(createTextPdf(2, 3));
	act(() =>
		second.api.setSelection(
			{ pageNumber: 1, offset: 5 },
			{ pageNumber: 1, offset: 6 },
		),
	);
	expect(first.api.selection).toBeNull();
	expect(second.api.getText()).toBe("1");
});

test("touch scrolling keeps a saved selection without starting mouse autoscroll", async () => {
	const r = await reader();
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: 4 },
		),
	);
	r.viewport.dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			pointerType: "touch",
			pointerId: 42,
			clientX: 100,
			clientY: 450,
		}),
	);
	act(() => {
		r.viewport.scrollTop = 802 * 10;
		r.viewport.dispatchEvent(new Event("scroll"));
	});
	r.viewport.dispatchEvent(
		new PointerEvent("pointerup", {
			bubbles: true,
			pointerType: "touch",
			pointerId: 42,
		}),
	);
	await waitFor(() => expect(r.page(1)).toBeNull());
	expect(r.api.getText()).toBe("Page");
});

test("native clearing also clears a selection whose other endpoint is offscreen", async () => {
	const r = await reader(createTextPdf(10, 3));
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 5, offset: 4 },
		),
	);
	await act(async () => {
		await r.api.getSelectionAsync();
	});
	expect(document.getSelection()?.isCollapsed).toBe(false);
	document.getSelection()?.removeAllRanges();
	await waitFor(() => expect(r.api.selection).toBeNull());
});

test("invalid anchors fail explicitly and never leave hidden text layers behind", async () => {
	const r = await reader(createTextPdf(10, 3));
	expect(() =>
		r.api.setSelection(
			{ pageNumber: 0, offset: 0 },
			{ pageNumber: 1, offset: 4 },
		),
	).toThrow(RangeError);
	expect(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 1, offset: 10000 },
		),
	).toThrow(RangeError);
	act(() =>
		r.api.setSelection(
			{ pageNumber: 1, offset: 0 },
			{ pageNumber: 5, offset: 10000 },
		),
	);
	await act(async () => {
		await expect(r.api.getSelectionAsync()).rejects.toThrow(RangeError);
	});
	expect(r.api.selection?.status).toBe("error");
	expect(r.api.getText()).toBeNull();
	await waitFor(() =>
		expect(
			document.querySelectorAll('.textLayer[aria-hidden="true"]').length,
		).toBe(0),
	);
});
