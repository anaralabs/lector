import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { applyFormOp, type FormContext, readWidgets, saveDocument } from "../src/form-fill.ts";
import { FormDirt, type FormWidget, widgetAt } from "../src/forms.ts";
// @ts-expect-error plain .mjs script, no types
import { fillable } from "../bench/fixtures/make-form.mjs";

const widget = (index: number, rect: FormWidget["rect"], extra: Partial<FormWidget> = {}): FormWidget => ({ index, rect, kind: "text", name: `f${index}`, value: "", readOnly: false, ...extra });

test("hit-testing picks the topmost interactive widget and skips read-only and signature fields", () => {
	const ws = [widget(0, [0, 0, 100, 100]), widget(1, [50, 50, 150, 150]), widget(2, [0, 0, 20, 20], { readOnly: true }), widget(3, [200, 0, 220, 20], { kind: "signature" })];
	assert.equal(widgetAt(ws, 60, 60)?.index, 1);
	assert.equal(widgetAt(ws, 10, 10)?.index, 0);
	assert.equal(widgetAt(ws, 210, 10), null);
	assert.equal(widgetAt(ws, 300, 300), null);
	assert.equal(widgetAt(undefined, 1, 1), null);
});

test("an edit re-versions only the tiles over it, and whole-page bitmaps", () => {
	const dirt = new FormDirt();
	assert.equal(dirt.any, false);
	assert.equal(dirt.version(0, null), 0);
	dirt.bump(0, [100, 100, 200, 120]);
	assert.equal(dirt.edited(0), true);
	assert.equal(dirt.edited(1), false);
	const over = dirt.version(0, [0, 0, 512, 512]);
	assert.ok(over > 0);
	assert.equal(dirt.version(0, [300, 300, 400, 400]), 0, "a tile away from the field keeps its version (and its texture)");
	assert.equal(dirt.version(0, null), over, "the whole-page bitmap includes the field");
	assert.equal(dirt.version(1, null), 0, "other pages are untouched");
	dirt.bump(0, [100, 100, 200, 120]);
	assert.ok(dirt.version(0, [0, 0, 512, 512]) > over, "typing again in the same field bumps the same region");
	dirt.bump(2, null);
	assert.ok(dirt.version(2, [0, 0, 1, 1]) > 0, "a null box covers the whole page");
	dirt.bumpAll();
	const all = dirt.version(5, [0, 0, 1, 1]);
	assert.ok(all > 0 && dirt.edited(5), "bumpAll reaches pages never edited before");
});

const require = createRequire(import.meta.url);

async function openForm() {
	const { init } = await import(require.resolve("@embedpdf/pdfium").replace(/index\.cjs$/, "index.js"));
	const P = await init({ wasmBinary: readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")) });
	P.PDFiumExt_Init();
	const bytes: Uint8Array = await fillable();
	const heap = () => (P.pdfium as { HEAPU8: Uint8Array }).HEAPU8;
	const ptr = P.pdfium.wasmExports.malloc(bytes.length);
	heap().set(bytes, ptr);
	const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
	const form = P.PDFiumExt_InitFormFillEnvironment(doc, P.PDFiumExt_OpenFormFillInfo());
	const pages = new Map<number, number>();
	const H = 792;
	const ctx: FormContext = {
		P,
		doc,
		form,
		heap,
		withPage: (index, fn) => {
			let page = pages.get(index);
			if (!page) {
				page = P.FPDF_LoadPage(doc, index) as number;
				P.FORM_OnAfterLoadPage(page, form);
				pages.set(index, page);
			}
			return fn(page);
		},
		toPage: (_, x, y) => [x, H - y],
		toUser: (_, x, y) => [x, H - y],
	};
	return ctx;
}

test("form edits through PDFium: text, checkbox, radio, dropdown, list box, and save", async () => {
	const ctx = await openForm();
	const widgets = () => ctx.withPage(0, (page) => readWidgets(ctx, 0, page));
	const byName = (name: string) => widgets().find((w) => w.name === name)!;
	const initial = widgets();
	assert.deepEqual(
		initial.map((w) => [w.name, w.kind]),
		[
			["name", "text"],
			["notes", "text"],
			["agree", "checkbox"],
			["size", "radio"],
			["size", "radio"],
			["color", "combo"],
			["fruit", "list"],
		],
	);
	assert.deepEqual(byName("name").rect, [159.5, 127.5, 410.5, 152.5]);
	assert.equal(byName("notes").multiline, true);
	assert.deepEqual(byName("color").options, ["Red", "Green", "Blue"]);
	assert.equal(byName("color").value, "Red");

	const name = byName("name");
	assert.deepEqual(applyFormOp(ctx, { k: "text", page: 0, index: name.index, value: "Ada Lovelace" }, true).changed, [{ name: "name", value: "Ada Lovelace" }]);
	assert.equal(byName("name").value, "Ada Lovelace");
	const page2 = ctx.withPage(1, (page) => readWidgets(ctx, 1, page));
	assert.equal(page2[0]!.value, "Ada Lovelace", "the same field on another page shares the value");
	assert.deepEqual(applyFormOp(ctx, { k: "text", page: 0, index: name.index, value: "" }, true).changed, [{ name: "name", value: "" }]);
	assert.deepEqual(applyFormOp(ctx, { k: "text", page: 0, index: byName("notes").index, value: "line 1\nline 2" }, true).changed[0]?.name, "notes");

	const agree = byName("agree").rect;
	const click = (r: FormWidget["rect"]) => ({ k: "click" as const, page: 0, x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, mods: 0 });
	assert.deepEqual(applyFormOp(ctx, click(agree), true).changed, [{ name: "agree", value: "Yes" }]);
	assert.deepEqual(applyFormOp(ctx, click(agree), true).changed, [{ name: "agree", value: "Off" }]);
	const large = widgets().filter((w) => w.name === "size")[1]!.rect;
	assert.deepEqual(applyFormOp(ctx, click(large), true).changed, [{ name: "size", value: "large" }]);
	assert.deepEqual(applyFormOp(ctx, { k: "click", page: 0, x: 500, y: 700, mods: 0 }, true).changed, [], "a click off every field changes nothing");

	assert.deepEqual(applyFormOp(ctx, { k: "choose", page: 0, index: byName("color").index, option: 2 }, true).changed, [{ name: "color", value: "Blue" }]);
	const fruit = byName("fruit").rect;
	// second row of three in the list box
	assert.deepEqual(applyFormOp(ctx, { k: "click", page: 0, x: fruit[0] + 20, y: fruit[1] + (fruit[3] - fruit[1]) / 2, mods: 0 }, true).changed, [{ name: "fruit", value: "Banana" }]);

	assert.deepEqual(applyFormOp(ctx, click(agree), false), { changed: [], reset: false }, "workers that do not report apply without reading values");
	assert.equal(byName("agree").value, "Yes");

	const saved = saveDocument(ctx);
	const text = new TextDecoder("latin1").decode(saved);
	assert.match(text, /^%PDF-/);
	assert.match(text, /Ada Lovelace|\(Blue\)|Banana/);
});
