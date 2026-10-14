import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSelectionBackground } from "../src/lib/selection-background";

const cleanup: (() => void)[] = [];

const addStyle = (css: string) => {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
	cleanup.push(() => style.remove());
	return style;
};

const buildLayer = () => {
	const layer = document.createElement("div");
	layer.className = "textLayer";
	layer.style.cssText =
		"position:absolute;left:0;top:0;width:400px;height:200px;font-size:12px";
	for (let i = 0; i < 4; i++) {
		const span = document.createElement("span");
		span.textContent = `line ${i} of this page`;
		span.style.cssText = `position:absolute;left:10px;top:${10 + i * 20}px;white-space:pre`;
		layer.append(span);
	}
	document.body.append(layer);
	cleanup.push(() => layer.remove());
	return layer;
};

const selectAll = (layer: HTMLElement) => {
	const spans = layer.querySelectorAll("span");
	const range = document.createRange();
	range.setStart(spans[0]!.firstChild!, 0);
	range.setEnd(spans[spans.length - 1]!.firstChild!, 4);
	const selection = document.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
};

/** Counts the `::selection` reads, which are the expensive ones: each has to
 * drop the attribute that suppresses native paint, invalidating every span. */
const countSelectionReads = <T,>(run: () => T) => {
	const original = window.getComputedStyle;
	let reads = 0;
	window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
		if (pseudo === "::selection") reads += 1;
		return original.call(window, element, pseudo ?? undefined);
	}) as typeof window.getComputedStyle;
	try {
		run();
	} finally {
		window.getComputedStyle = original;
	}
	return reads;
};

const selectionStyle = () =>
	[...document.head.querySelectorAll("style")].filter((style) =>
		style.textContent?.includes("data-lector-selection-active"),
	);

beforeEach(() => {
	addStyle(".textLayer ::selection { background-color: rgb(0, 100, 255); }");
});

afterEach(() => {
	document.getSelection()?.removeAllRanges();
	for (const undo of cleanup.splice(0)) undo();
});

describe("selection background colour cache", () => {
	test("reads ::selection once, not once per selectionchange", () => {
		const layer = buildLayer();
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		cleanup.push(() => background.clear(layer));

		expect(
			countSelectionReads(() => background.update(selection, [layer])),
		).toBe(1);
		expect(layer.getAttribute("data-lector-selection-active")).toBe("");

		const observer = new MutationObserver(() => {});
		observer.observe(layer, {
			attributes: true,
			attributeOldValue: true,
			attributeFilter: ["data-lector-selection-active"],
		});
		const reads = countSelectionReads(() => {
			for (let i = 0; i < 20; i++) background.update(selection, [layer]);
		});
		// oldValue is null only when the attribute was absent, so each of these is
		// a remove/add cycle — the thing that invalidates every span in the layer.
		const removals = observer
			.takeRecords()
			.filter((record) => record.oldValue === null).length;
		observer.disconnect();

		expect(reads).toBe(0);
		expect(removals).toBe(0);
		expect(layer.querySelector("svg[data-lector-selection] path")).toBeTruthy();
	});

	test("forget() makes the next update read the colour again", () => {
		const layer = buildLayer();
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		cleanup.push(() => background.clear(layer));

		background.update(selection, [layer]);
		background.forget();
		expect(
			countSelectionReads(() => background.update(selection, [layer])),
		).toBe(1);
		expect(
			countSelectionReads(() => background.update(selection, [layer])),
		).toBe(0);
	});

	test("a theme change on the document element re-reads the colour", () => {
		const layer = buildLayer();
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		cleanup.push(() => background.clear(layer));
		const root = document.documentElement;
		const theme = root.dataset.theme;
		cleanup.push(() => {
			if (theme === undefined) delete root.dataset.theme;
			else root.dataset.theme = theme;
		});

		addStyle(
			'[data-theme="night"] .textLayer ::selection { background-color: rgb(200, 0, 0); }',
		);
		background.update(selection, [layer]);
		const before = layer
			.querySelector("svg[data-lector-selection] path")!
			.getAttribute("fill");

		root.dataset.theme = "night";
		expect(
			countSelectionReads(() => background.update(selection, [layer])),
		).toBe(1);
		const after = layer
			.querySelector("svg[data-lector-selection] path")!
			.getAttribute("fill");
		expect(before).toBe("rgb(0, 100, 255)");
		expect(after).toBe("rgb(200, 0, 0)");
	});

	test("a style sheet edit in the same task re-reads the colour", () => {
		const layer = buildLayer();
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		cleanup.push(() => background.clear(layer));
		const fill = () =>
			layer
				.querySelector("svg[data-lector-selection] path")!
				.getAttribute("fill");

		background.update(selection, [layer]);
		expect(fill()).toBe("rgb(0, 100, 255)");

		// No await: a consumer that restyles and selects synchronously still sees it.
		const restyle = addStyle("");
		restyle.textContent =
			".textLayer ::selection { background-color: rgb(12, 34, 56); }";
		expect(
			countSelectionReads(() => background.update(selection, [layer])),
		).toBe(1);
		expect(fill()).toBe("rgb(12, 34, 56)");
	});

	test("taking a style sheet out of its media re-reads the colour", () => {
		const layer = buildLayer();
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		cleanup.push(() => background.clear(layer));
		const fill = () =>
			layer
				.querySelector("svg[data-lector-selection] path")!
				.getAttribute("fill");

		const night = addStyle(
			".textLayer ::selection { background-color: rgb(9, 9, 9); }",
		);
		background.update(selection, [layer]);
		expect(fill()).toBe("rgb(9, 9, 9)");

		night.setAttribute("media", "print");
		expect(
			countSelectionReads(() => background.update(selection, [layer])),
		).toBe(1);
		expect(fill()).toBe("rgb(0, 100, 255)");
	});

	test("destroy() releases the stylesheet and stops watching", () => {
		const layer = buildLayer();
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		const before = selectionStyle().length;

		background.update(selection, [layer]);
		expect(selectionStyle()).toHaveLength(before + 1);

		background.clear(layer);
		background.destroy();
		expect(selectionStyle()).toHaveLength(before);
	});

	test("clearing the last overlay keeps the stylesheet installed", () => {
		const layer = buildLayer();
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		// Each background installs its own; count only this one's.
		const before = selectionStyle().length;

		background.update(selection, [layer]);
		expect(selectionStyle()).toHaveLength(before + 1);

		background.clear(layer);
		expect(layer.hasAttribute("data-lector-selection-active")).toBe(false);
		expect(layer.querySelector("svg[data-lector-selection]")).toBeNull();
		// Removing a stylesheet restyles the whole document; the rule is inert
		// while no layer carries the attribute, so it stays.
		expect(selectionStyle()).toHaveLength(before + 1);

		background.update(selection, [layer]);
		expect(selectionStyle()).toHaveLength(before + 1);
		background.clear(layer);
	});

	test("a transparent ::selection still clears the overlay", () => {
		const layer = buildLayer();
		layer.style.setProperty("--ignored", "0");
		addStyle(
			".textLayer ::selection { background-color: rgba(0, 0, 0, 0) !important; }",
		);
		const selection = selectAll(layer);
		const background = createSelectionBackground();
		background.update(selection, [layer]);
		expect(layer.querySelector("svg[data-lector-selection]")).toBeNull();
		expect(layer.hasAttribute("data-lector-selection-active")).toBe(false);
	});
});
