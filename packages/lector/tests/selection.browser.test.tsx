import { cleanup, render, waitFor } from "@testing-library/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useEffect } from "react";
import { afterEach, expect, test } from "vitest";
import { page as browserPage, commands } from "vitest/browser";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { PDFStore, usePdf } from "../src/internal";
import "pdfjs-dist/web/pdf_viewer.css";
import attention from "./fixtures/attention-page-3.json";

declare module "vitest/browser" {
	interface BrowserCommands {
		mouse(
			action: string,
			x?: number,
			y?: number,
			shift?: boolean,
		): Promise<void>;
	}
}

function TestViewport({
	children,
	scroll,
	persistent,
}: {
	children: React.ReactNode;
	scroll: boolean;
	persistent: boolean;
}) {
	const viewport = usePdf((state) => state.viewportRef);
	const selection = usePdf((state) => state.selection);
	useEffect(() => {
		if (persistent && viewport.current)
			return selection.connect(viewport.current);
	}, [persistent, selection, viewport]);
	return (
		<div
			ref={viewport}
			data-testid="viewport"
			style={{
				width: 1200,
				height: scroll ? 250 : undefined,
				overflow: scroll ? "auto" : undefined,
			}}
		>
			{children}
		</div>
	);
}

const lines = [
	"Encoder: The encoder is composed of a stack of identical layers.",
	"Each layer has two sub-layers and a feed-forward network.",
	"Decoder: The decoder is also composed of identical layers.",
	"The output depends on the known outputs at earlier positions.",
];

async function setup(
	scale = 1,
	pages = 1,
	scroll = false,
	recorded = false,
	persistent = false,
) {
	await browserPage.viewport(2000, 1000);
	document.body.style.margin = "0";
	const viewport = {
		width: 600,
		height: 400,
		scale: 1,
		rotation: 0,
		transform: [1, 0, 0, -1, 0, 400],
		rawDims: { pageWidth: 600, pageHeight: 400, pageX: 0, pageY: 0 },
	} as unknown as PageViewport;
	if (recorded)
		Object.assign(viewport, attention.viewport, {
			rawDims: { pageWidth: 612, pageHeight: 792, pageX: 0, pageY: 0 },
		});
	const page = {
		pageNumber: 1,
		getViewport: () => viewport,
		streamTextContent: () =>
			new ReadableStream({
				start(controller) {
					controller.enqueue(
						recorded
							? attention.text
							: {
									items: lines.map((str, i) => ({
										str,
										dir: "ltr",
										width: str.length * 7,
										height: 14,
										transform: [
											14,
											0,
											0,
											14,
											70,
											320 - i * 24 - (i > 1 ? 20 : 0),
										],
										fontName: "f1",
										hasEOL: true,
									})),
									styles: {
										f1: {
											fontFamily: "monospace",
											ascent: 0.8,
											descent: -0.2,
											vertical: false,
										},
									},
								},
					);
					controller.close();
				},
			}),
	} as unknown as PDFPageProxy;
	const proxies = Array.from(
		{ length: pages },
		(_, i) => ({ ...page, pageNumber: i + 1 }) as PDFPageProxy,
	);
	const view = render(
		<PDFStore.Provider
			initialValue={{
				pdfDocumentProxy: { numPages: pages } as PDFDocumentProxy,
				pageProxies: proxies,
				viewports: proxies.map(() => viewport),
				zoom: 1,
			}}
		>
			<TestViewport scroll={scroll} persistent={persistent}>
				<div
					style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
				>
					{proxies.map((p) => (
						<Page key={p.pageNumber} pageNumber={p.pageNumber}>
							<TextLayer />
						</Page>
					))}
				</div>
			</TestViewport>
		</PDFStore.Provider>,
	);
	await waitFor(() =>
		expect(
			view.container.querySelectorAll(".textLayer span").length,
		).toBeGreaterThanOrEqual(recorded ? 20 : 4 * pages),
	);
	await new Promise(requestAnimationFrame);
	return Array.from(
		view.container.querySelectorAll<HTMLElement>(".textLayer span"),
	);
}
const point = (span: HTMLElement, end = false) => {
	const r = span.getBoundingClientRect();
	return [end ? r.right - 1 : r.left + 1, r.top + r.height / 2] as const;
};
async function drag(
	start: readonly [number, number],
	end: readonly [number, number],
) {
	await commands.mouse("down", ...start);
	await commands.mouse("move", ...end);
	await commands.mouse("up");
}
afterEach(() => {
	cleanup();
	document.getSelection()?.removeAllRanges();
});

test("paragraph start stays the anchor across repeated forward and backward drags", async () => {
	const spans = await setup();
	for (let i = 0; i < 3; i++) {
		await drag(point(spans[0]!), point(spans[1]!, true));
		expect(document.getSelection()?.toString()).toContain(lines[0]);
		expect(document.getSelection()?.toString()).not.toContain("Decoder");
		expect(document.getSelection()?.anchorNode).toBe(spans[0]!.firstChild);
		await drag(point(spans[3]!, true), point(spans[2]!));
		expect(document.getSelection()?.toString()).toContain(lines[2]);
	}
});

test("drag beginning in the left page margin selects from that line, not the bottom", async () => {
	const spans = await setup();
	const start = point(spans[0]!);
	await drag([start[0] - 20, start[1]], point(spans[1]!, true));
	expect(document.getSelection()?.anchorNode).toBe(spans[0]!.firstChild);
	expect(document.getSelection()?.toString()).toContain(lines[0]);
	expect(document.getSelection()?.toString()).not.toContain("Decoder");
});

test("drag through empty space after a short line ends on that line", async () => {
	const spans = await setup();
	const end = point(spans[1]!, true);
	await drag(point(spans[0]!), [570, end[1]]);
	expect(document.getSelection()?.toString()).toContain(lines[1]);
	expect(document.getSelection()?.toString()).not.toContain("Decoder");
});

for (const scale of [0.5, 1.97, 3]) {
	test(`margin and reverse drags at ${scale}x zoom`, async () => {
		const spans = await setup(scale);
		const start = point(spans[0]!);
		await drag([start[0] - 15 * scale, start[1]], point(spans[1]!, true));
		expect(document.getSelection()?.anchorNode).toBe(spans[0]!.firstChild);
		expect(document.getSelection()?.focusNode).toBe(spans[1]!.firstChild);
		await drag(point(spans[1]!, true), [start[0] - 15 * scale, start[1]]);
		expect(document.getSelection()?.focusOffset).toBe(0);
	});
}

test("reversing across the original anchor preserves it", async () => {
	const spans = await setup();
	await commands.mouse("down", ...point(spans[1]!));
	await commands.mouse("move", ...point(spans[3]!, true));
	await commands.mouse("move", ...point(spans[0]!));
	expect(document.getSelection()?.anchorNode).toBe(spans[1]!.firstChild);
	expect(document.getSelection()?.focusNode).toBe(spans[0]!.firstChild);
	await commands.mouse("up");
});

test("paragraph gaps resolve to the nearest line", async () => {
	const spans = await setup();
	const r = spans[2]!.getBoundingClientRect();
	await drag([r.left - 15, r.top - 3], point(spans[3]!, true));
	expect(document.getSelection()?.anchorNode).toBe(spans[2]!.firstChild);
	expect(document.getSelection()?.toString()).toContain(lines[2]);
	expect(document.getSelection()?.toString()).not.toContain("Encoder");
});

test("non-text page overlays can start a text selection", async () => {
	const spans = await setup();
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:absolute;inset:0;z-index:10";
	spans[0]!.closest(".textLayer")!.parentElement!.append(overlay);
	await drag(point(spans[0]!), point(spans[1]!, true));
	expect(document.getSelection()?.toString()).toContain(lines[0]);
	expect(document.getSelection()?.focusNode).toBe(spans[1]!.firstChild);
});

test("double click keeps native word selection", async () => {
	const spans = await setup();
	const [x, y] = point(spans[0]!);
	await commands.mouse("double", x + 20, y);
	expect(document.getSelection()?.toString()).toBe("Encoder");
});

test("shift-click extends the existing anchor", async () => {
	const spans = await setup();
	await commands.mouse("click", ...point(spans[0]!));
	await commands.mouse("click", ...point(spans[1]!, true), true);
	expect(document.getSelection()?.anchorNode).toBe(spans[0]!.firstChild);
	expect(document.getSelection()?.toString()).toContain(lines[1]);
});

test("links and form fields keep their mouse behavior", async () => {
	const spans = await setup();
	const button = document.createElement("button");
	button.textContent = "Action";
	button.style.cssText = "position:absolute;left:30px;top:30px;z-index:10";
	let clicked = false;
	button.onclick = () => {
		clicked = true;
	};
	spans[0]!.closest(".textLayer")!.parentElement!.append(button);
	await drag(point(spans[0]!), point(spans[1]!, true));
	await commands.mouse("click", 40, 40);
	expect(clicked).toBe(true);
	expect(document.querySelector(".selecting")).toBeNull();
});

test("cross-page drags keep endpoints in document order", async () => {
	const spans = await setup(1, 2);
	await drag(point(spans[2]!), point(spans[5]!, true));
	expect(document.getSelection()?.anchorNode).toBe(spans[2]!.firstChild);
	expect(document.getSelection()?.focusNode).toBe(spans[5]!.firstChild);
	expect(document.getSelection()?.toString()).toContain(lines[3]);
	await drag(point(spans[5]!, true), point(spans[2]!));
	expect(document.getSelection()?.anchorNode).toBe(spans[5]!.firstChild);
	expect(document.getSelection()?.focusNode).toBe(spans[2]!.firstChild);
});

test("blur and pointer cancellation release the drag", async () => {
	const spans = await setup();
	for (const cancel of [
		() => window.dispatchEvent(new Event("blur")),
		() => document.dispatchEvent(new Event("pointercancel")),
	]) {
		await commands.mouse("down", ...point(spans[0]!));
		await commands.mouse("move", ...point(spans[1]!, true));
		const before = document.getSelection()?.toString();
		cancel();
		await commands.mouse("move", ...point(spans[3]!, true));
		await commands.mouse("up");
		expect(document.getSelection()?.toString()).toBe(before);
		expect(document.querySelector(".selecting")).toBeNull();
	}
});

test("scrolling updates drag geometry and auto-scroll stops on release", async () => {
	const spans = await setup(1, 2, true);
	const viewport = document.querySelector<HTMLElement>(
		'[data-testid="viewport"]',
	)!;
	await commands.mouse("down", ...point(spans[0]!));
	await commands.mouse("move", 200, 248);
	await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(20));
	await commands.mouse("up");
	const top = viewport.scrollTop;
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(viewport.scrollTop).toBe(top);
});

test.each([false, true])(
	"recorded Encoder paragraph at 197% keeps its top anchor (persistent=%s)",
	async (persistent) => {
		const spans = await setup(1.97, 1, false, true, persistent);
		const encoder = spans.find((s) => s.textContent === "Encoder:")!;
		const decoder = spans.find((s) => s.textContent === "Decoder:")!;
		expect(encoder).toBeTruthy();
		expect(decoder).toBeTruthy();
		// Translate the zoomed page just as the scrolled viewer in the recording does.
		const page = encoder.closest(".textLayer")!.parentElement!;
		page.style.top = "-380px";
		const last = spans[spans.indexOf(decoder) - 1]!;
		for (const margin of [0, 1, 3, 12, 30]) {
			const start = point(encoder);
			await drag([start[0] - margin, start[1]], point(last, true));
			expect(document.getSelection()?.anchorNode).toBe(encoder.firstChild);
			expect(document.getSelection()?.anchorOffset).toBe(0);
			expect(document.getSelection()?.toString()).toContain("Encoder:");
			expect(document.getSelection()?.toString()).not.toContain("Decoder:");
		}
	},
);

test("partial-word drags preserve character offsets", async () => {
	const spans = await setup();
	const node = spans[0]!.firstChild!;
	const range = document.createRange();
	const caret = (offset: number) => {
		range.setStart(node, offset);
		range.collapse(true);
		const r = range.getBoundingClientRect();
		return [r.left, r.top + r.height / 2] as const;
	};
	await drag(caret(2), caret(7));
	expect(document.getSelection()?.toString()).toBe("coder");
});

test("above and below the text clamp to document endpoints", async () => {
	const spans = await setup();
	await drag([70, 20], [570, 380]);
	expect(document.getSelection()?.anchorNode).toBe(spans[0]!.firstChild);
	expect(document.getSelection()?.anchorOffset).toBe(0);
	expect(document.getSelection()?.focusNode).toBe(spans[3]!.firstChild);
	expect(document.getSelection()?.focusOffset).toBe(
		spans[3]!.textContent!.length,
	);
});

test("separate viewers do not share anchors or select each other's text", async () => {
	const first = await setup();
	const second = await setup();
	await drag(point(first[0]!), point(second[1]!, true));
	expect(document.getSelection()?.focusNode).toBe(first[3]!.firstChild);
	await commands.mouse("click", ...point(second[0]!), true);
	expect(document.getSelection()?.anchorNode).toBe(second[0]!.firstChild);
});

test("unmounting during a drag releases listeners and a new viewer works", async () => {
	const spans = await setup();
	await commands.mouse("down", ...point(spans[0]!));
	cleanup();
	await commands.mouse("move", 300, 200);
	await commands.mouse("up");
	const next = await setup();
	await drag(point(next[0]!), point(next[1]!, true));
	expect(document.getSelection()?.toString()).toContain(lines[0]);
});

test("RTL text and caret fallback work through a covering layer", async () => {
	const spans = await setup();
	const span = spans[0]!;
	span.textContent = "مرحبا بالعالم";
	span.dir = "rtl";
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:absolute;inset:0;z-index:10";
	span.closest(".textLayer")!.parentElement!.append(overlay);
	const r = span.getBoundingClientRect();
	await drag(
		[r.right + 5, r.top + r.height / 2],
		[r.left - 5, r.top + r.height / 2],
	);
	expect(document.getSelection()?.toString()).toBe(span.textContent);
	expect(document.getSelection()?.anchorOffset).toBe(0);
});

test("touch compatibility mouse events leave the native selection alone", async () => {
	const spans = await setup();
	await drag(point(spans[0]!), point(spans[1]!, true));
	const text = document.getSelection()?.toString();
	spans[2]!.dispatchEvent(
		new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
	);
	spans[2]!.dispatchEvent(
		new MouseEvent("mousedown", { bubbles: true, clientX: 80, clientY: 145 }),
	);
	expect(document.getSelection()?.toString()).toBe(text);
	expect(document.querySelector(".selecting")).toBeNull();
});

test("links and text fields remain clickable and focusable", async () => {
	const spans = await setup();
	const page = spans[0]!.closest(".textLayer")!.parentElement!;
	const link = document.createElement("a");
	link.href = "#selection-test";
	link.textContent = "Link";
	link.style.cssText = "position:absolute;left:20px;top:20px;z-index:10";
	let clicked = false;
	link.onclick = (event) => {
		event.preventDefault();
		clicked = true;
	};
	const input = document.createElement("input");
	input.style.cssText = "position:absolute;left:80px;top:20px;z-index:10";
	page.append(link, input);
	await commands.mouse("click", 25, 25);
	expect(clicked).toBe(true);
	await commands.mouse("click", 90, 25);
	expect(document.activeElement).toBe(input);
	expect(document.querySelector(".selecting")).toBeNull();
});

test("rotated text keeps the same character boundaries", async () => {
	const spans = await setup();
	const page = spans[0]!.closest(".textLayer")!.parentElement!;
	page.style.transform = "translateX(400px) rotate(90deg)";
	page.style.transformOrigin = "top left";
	const range = document.createRange();
	const caret = (node: Node, offset: number) => {
		range.setStart(node, offset);
		range.collapse(true);
		const r = range.getBoundingClientRect();
		return [r.left + r.width / 2, r.top + r.height / 2] as const;
	};
	await drag(caret(spans[0]!.firstChild!, 2), caret(spans[1]!.firstChild!, 10));
	expect(document.getSelection()?.anchorNode).toBe(spans[0]!.firstChild);
	expect(document.getSelection()?.anchorOffset).toBe(2);
	expect(document.getSelection()?.focusNode).toBe(spans[1]!.firstChild);
	expect(document.getSelection()?.focusOffset).toBe(10);
});
