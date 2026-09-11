import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { useSelectionDimensions } from "../src/hooks/useSelectionDimensions";
import { PDFStore } from "../src/internal";
import {
	getPdfSelectionText,
	registerPdfCopy,
} from "../src/lib/selection-text";
import { wrapperFor } from "./helpers";

afterEach(() => {
	cleanup();
	document.getSelection()?.removeAllRanges();
	document.querySelectorAll("[data-copy-fixture]").forEach((node) => {
		node.remove();
	});
});

function fixture(html: string) {
	const scope = document.createElement("div");
	scope.dataset.copyFixture = "";
	scope.innerHTML = html;
	document.body.append(scope);
	return scope;
}

function select(scope: HTMLElement) {
	const spans = scope.querySelectorAll(".textLayer span");
	const range = document.createRange();
	range.setStart(spans[0]!.firstChild!, 0);
	range.setEnd(
		spans[spans.length - 1]!.firstChild!,
		spans[spans.length - 1]!.textContent!.length,
	);
	const selection = document.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
}

function copy(target: EventTarget = document) {
	const event = new Event("copy", {
		bubbles: true,
		cancelable: true,
	}) as ClipboardEvent;
	const data = new Map<string, string>();
	Object.defineProperty(event, "clipboardData", {
		value: { setData: (type: string, text: string) => data.set(type, text) },
	});
	target.dispatchEvent(event);
	return { event, text: data.get("text/plain") };
}

test("cross-page copy includes selected PDF text only, with page boundaries", () => {
	const scope = fixture(
		'<div class="textLayer" data-page-number="1"><span>First page.</span></div><button>Delete annotation</button><div class="textLayer" data-page-number="2"><span>Second page.</span></div>',
	);
	const selection = select(scope);
	expect(getPdfSelectionText(selection, scope)).toBe(
		"First page.\n\nSecond page.",
	);
	expect(getPdfSelectionText(selection, scope, { lineBreaks: "space" })).toBe(
		"First page.\n\nSecond page.",
	);
	const dispose = registerPdfCopy(scope, () => ({}));
	try {
		expect(copy().text).toBe("First page.\n\nSecond page.");
	} finally {
		dispose();
	}
});

test("copy never presents missing virtualized pages as a complete passage", () => {
	const scope = fixture(
		'<div class="textLayer" data-page-number="1"><span>First page.</span></div><div class="textLayer" data-page-number="3"><span>Third page.</span></div>',
	);
	expect(getPdfSelectionText(select(scope), scope)).toBeNull();
	const dispose = registerPdfCopy(scope, () => ({}));
	try {
		expect(copy().event.defaultPrevented).toBe(false);
	} finally {
		dispose();
	}
});

test("copy options join wrapped prose explicitly and retain paragraph boundaries and compounds", () => {
	const scope = fixture(
		'<div class="textLayer" data-page-number="1"><span>An inter-</span><br><span>national study.</span><br><br><span>State-of-the-art.</span></div>',
	);
	const selection = select(scope);
	expect(getPdfSelectionText(selection, scope)).toBe(
		"An inter-\nnational study.\n\nState-of-the-art.",
	);
	expect(
		getPdfSelectionText(selection, scope, {
			lineBreaks: "space",
			ignoreHyphenation: true,
		}),
	).toBe("An international study.\n\nState-of-the-art.");
});

test.each([
	"שלום עולם",
	"مرحبا بالعالم",
	"日本語",
	"किताब",
	"👨‍👩‍👧‍👦",
	"E = mc²",
])("selection preserves logical order and meaningful Unicode in %s", (text) => {
	const scope = fixture(
		'<div class="textLayer" data-page-number="1"><span></span></div>',
	);
	scope.querySelector("span")!.textContent = text;
	expect(getPdfSelectionText(select(scope), scope)).toBe(text);
});

test("a partial selection is clipped at both text-node boundaries", () => {
	const scope = fixture(
		'<div class="textLayer" data-page-number="1"><span>Prefix hello</span><br><span>world suffix</span></div>',
	);
	const selection = select(scope);
	const range = selection.getRangeAt(0);
	range.setStart(range.startContainer, 7);
	range.setEnd(range.endContainer, 5);
	expect(getPdfSelectionText(selection, scope)).toBe("hello\nworld");
	range.setEnd(range.startContainer, 12);
	expect(getPdfSelectionText(selection, scope)).toBe("hello");
});

test("copy respects custom handlers, editable fields, opt-out and listener cleanup", () => {
	const scope = fixture(
		'<input value="form value"><div class="textLayer" data-page-number="1"><span>ofﬁce</span></div>',
	);
	select(scope);
	let enabled = true;
	const dispose = registerPdfCopy(scope, () => (enabled ? {} : false));
	try {
		expect(copy(scope.querySelector("input")!).event.defaultPrevented).toBe(
			false,
		);
		expect(copy().text).toBe("office");
		enabled = false;
		expect(copy().event.defaultPrevented).toBe(false);
		enabled = true;
		scope.addEventListener("copy", (event) => event.preventDefault(), {
			once: true,
		});
		expect(copy(scope).text).toBeUndefined();
	} finally {
		dispose();
	}
	expect(copy().event.defaultPrevented).toBe(false);
});

test("two readers keep copy ownership isolated", () => {
	const first = fixture(
		'<div class="textLayer" data-page-number="1"><span>First</span></div>',
	);
	const second = fixture(
		'<div class="textLayer" data-page-number="1"><span>Second</span></div>',
	);
	const a = registerPdfCopy(first, () => ({}));
	const b = registerPdfCopy(second, () => ({}));
	try {
		expect(getPdfSelectionText(select(second), first)).toBeNull();
		expect(copy().text).toBe("Second");
		const range = document.getSelection()!.getRangeAt(0);
		range.setStart(first.querySelector("span")!.firstChild!, 0);
		expect(copy().event.defaultPrevented).toBe(false);
	} finally {
		a();
		b();
	}
});

test("Pages installs copying and reads updated options without remounting", () => {
	const view = render(
		<Pages>
			<Page>
				<div />
			</Page>
		</Pages>,
		{ wrapper: wrapperFor() },
	);
	// A mounted PDF.js text layer; selection/copy uses its DOM, not a second extraction.
	const layer = document.createElement("div");
	layer.className = "textLayer";
	layer.dataset.pageNumber = "1";
	layer.innerHTML = "<span>ofﬁce</span><br><span>study</span>";
	view.container.firstElementChild!.append(layer);
	select(view.container);
	expect(copy().text).toBe("office\nstudy");
	view.rerender(
		<Pages copyOptions={{ lineBreaks: "space" }}>
			<Page>
				<div />
			</Page>
		</Pages>,
	);
	expect(copy().text).toBe("office study");
	view.rerender(
		<Pages copyOptions={false}>
			<Page>
				<div />
			</Page>
		</Pages>,
	);
	expect(copy().event.defaultPrevented).toBe(false);
});

test("annotation quotes preserve line boundaries and copyable Unicode", () => {
	const scope = document.createElement("div");
	scope.dataset.copyFixture = "";
	scope.innerHTML =
		'<div class="textLayer" data-page-number="1"><span>My ofﬁce</span><br><span>café study.</span></div>';
	document.body.append(scope);
	const { result } = renderHook(
		() => ({
			dimensions: useSelectionDimensions(),
			store: PDFStore.useContext(),
		}),
		{ wrapper: wrapperFor() },
	);
	result.current.store.getState().viewportRef.current = scope;
	const range = document.createRange();
	range.setStart(scope.querySelector("span")!.firstChild!, 0);
	range.setEnd(scope.querySelectorAll("span")[1]!.firstChild!, 12);
	document.getSelection()!.addRange(range);
	expect(result.current.dimensions.getAnnotationDimension()!.text).toBe(
		"My office\ncafé study.",
	);
	expect(result.current.dimensions.getSelection()!.text).toBe(
		"My office\ncafé study.",
	);
});
