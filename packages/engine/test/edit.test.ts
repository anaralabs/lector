import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { before, test } from "node:test";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";

import { Editor, type EditHost } from "../src/edit.ts";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib") as typeof import("pdf-lib");
let P: WrappedPdfiumModule;

before(async () => {
	P = await init({ wasmBinary: readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")) } as never);
	P.PDFiumExt_Init();
});

async function fixture() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (let i = 0; i < 3; i++) {
		const page = pdf.addPage([612, 792]);
		page.drawText(`Page ${i + 1} heading`, { x: 72, y: 700, size: 24, font });
		page.drawRectangle({ x: 72, y: 500, width: 200, height: 100 });
	}
	return pdf.save();
}

/** In-memory document with a page cache, like the raster worker (no rotation in the fixture: y flips). */
function open(bytes: Uint8Array) {
	const ptr = P.pdfium.wasmExports.malloc(bytes.length);
	(P.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8.set(bytes, ptr);
	let doc = 0;
	const pages = new Map<number, number>();
	const load = () => {
		doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
		assert.ok(doc, "opens");
	};
	load();
	const host: EditHost = {
		P,
		doc: () => doc,
		pageCount: () => P.FPDF_GetPageCount(doc),
		page: (i) => {
			if (!pages.has(i)) pages.set(i, P.FPDF_LoadPage(doc, i));
			return pages.get(i)!;
		},
		toPage: (_i, x, y) => [x, 792 - y],
		toUser: (_i, x, y) => [x, 792 - y],
		resized: () => {},
		removed: (i) => {
			const next = new Map<number, number>();
			for (const [k, v] of pages) if (k !== i) next.set(k > i ? k - 1 : k, v);
			P.FPDF_ClosePage(pages.get(i) ?? 0);
			pages.clear();
			for (const [k, v] of next) pages.set(k, v);
		},
		reopen: () => {
			for (const p of pages.values()) P.FPDF_ClosePage(p);
			pages.clear();
			P.FPDF_CloseDocument(doc);
			load();
		},
	};
	return new Editor(host);
}

const texts = (ed: Editor, page = 0) => ed.objects(page).filter((o) => o.type === "text").map((o) => o.text);

test("set-text keeps the font when it has the glyphs, undo replays to the original", async () => {
	const ed = open(await fixture());
	const heading = ed.objects(0).find((o) => o.type === "text")!;
	const out = ed.apply({ kind: "set-text", page: 0, obj: heading.index, text: "Edited heading" });
	assert.equal(out.font, "same");
	assert.deepEqual(texts(ed), ["Edited heading"]);
	ed.undo();
	assert.deepEqual(texts(ed), ["Page 1 heading"]);
	ed.redo();
	assert.deepEqual(texts(ed), ["Edited heading"]);
});

test("text no font can encode is refused, and the page is unchanged", async () => {
	const ed = open(await fixture());
	const heading = ed.objects(0).find((o) => o.type === "text")!;
	assert.throws(() => ed.apply({ kind: "set-text", page: 0, obj: heading.index, text: "日本語" }), /embedded Unicode font/);
	assert.deepEqual(texts(ed), ["Page 1 heading"]);
});

test("add, delete and move have exact inverses", async () => {
	const ed = open(await fixture());
	const n = ed.objects(0).length;
	ed.apply({ kind: "add-text", page: 0, x: 72, y: 100, text: "Note", size: 12 });
	assert.equal(ed.objects(0).length, n + 1);
	const rect = ed.objects(0).find((o) => o.type === "path")!;
	ed.apply({ kind: "move-object", page: 0, obj: rect.index, dx: 10, dy: 20 });
	const moved = ed.objects(0).find((o) => o.type === "path")!;
	assert.ok(Math.abs(moved.box[0] - rect.box[0] - 10) < 0.01 && Math.abs(moved.box[1] - rect.box[1] - 20) < 0.01);
	ed.apply({ kind: "delete-object", page: 0, obj: rect.index });
	assert.equal(ed.objects(0).filter((o) => o.type === "path").length, 0);
	ed.undo();
	ed.undo();
	ed.undo();
	assert.equal(ed.objects(0).length, n);
	assert.deepEqual(ed.objects(0).find((o) => o.type === "path")!.box, rect.box);
});

test("page delete, rotate and undo through a replay; save reopens with the edits", async () => {
	const ed = open(await fixture());
	ed.apply({ kind: "set-text", page: 2, obj: 0, text: "Third page edited" });
	ed.apply({ kind: "delete-page", page: 0 });
	assert.deepEqual(texts(ed, 0), ["Page 2 heading"]);
	ed.apply({ kind: "rotate-page", page: 0, quarter: 1 });
	ed.undo();
	ed.undo();
	assert.deepEqual(texts(ed, 0), ["Page 1 heading"]);
	assert.deepEqual(texts(ed, 2), ["Third page edited"]);
	ed.redo();
	const saved = ed.save(false);
	const back = open(saved);
	assert.deepEqual(texts(back, 0), ["Page 2 heading"]);
	assert.deepEqual(texts(back, 1), ["Third page edited"]);
});

test("redaction removes the text under the rect", async () => {
	const ed = open(await fixture());
	ed.apply({ kind: "redact", page: 0, rect: [60, 70, 400, 100] });
	const back = open(ed.save(false));
	assert.deepEqual(texts(back).filter((t) => t?.trim()), []);
});
