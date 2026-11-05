// The ./node entry (built: run after `pnpm build`): same PDFium build and PageText as the viewer, in plain Node.
import assert from "node:assert/strict";
import { test } from "node:test";

const { EngineError, loadPdfium, PageText } = await import("../dist/node.js");
// @ts-expect-error plain .mjs scripts, no types
const { makePaper } = await import("../bench/fixtures/make-paper.mjs");
// @ts-expect-error plain .mjs scripts, no types
const { extractText } = await import("./fixtures/pdfium-text.mjs");
const { PDFDocument, StandardFonts, degrees } = await import("pdf-lib");

const pdfium = await loadPdfium();
const paper: Uint8Array = await makePaper();

test("page text matches PageText built from the untrimmed PDFium", async () => {
	const reference = await extractText(paper);
	const doc = pdfium.open(paper);
	assert.equal(doc.pageCount, reference.length);
	for (const ref of reference) {
		const page = doc.pageText(ref.page);
		const expected = new PageText(ref.codes, ref.boxes, ref.h).textWithMap();
		assert.equal(page.text, expected.text);
		assert.deepEqual(Array.from(page.chars), Array.from(expected.chars));
		assert.deepEqual(page.size, { w: ref.w, h: ref.h });
	}
	doc.close();
});

test("a text range selects that text, and its rects cover it", () => {
	const doc = pdfium.open(paper);
	const page = doc.pageText(0);
	const needle = "segmentation";
	const start = page.text.indexOf(needle);
	assert.ok(start >= 0);
	const end = start + needle.length;
	assert.equal(page.model.text(page.chars[start]!, page.chars[end - 1]! + 1), needle);
	const rects = page.rects(start, end);
	assert.equal(rects.length, 1);
	const r = rects[0]!;
	assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= page.size.w && r.y + r.h <= page.size.h);
	assert.deepEqual(page.rects(end, start), []);
	doc.close();
});

test("rotated pages: size and boxes are as displayed", async () => {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (const angle of [0, 90, 180, 270]) {
		const p = pdf.addPage([400, 600]);
		p.drawText("Rotated line of text", { x: 50, y: 500, size: 20, font });
		p.setRotation(degrees(angle));
	}
	const doc = pdfium.open(await pdf.save());
	for (const [i, angle] of [0, 90, 180, 270].entries()) {
		const page = doc.pageText(i);
		const sideways = angle % 180 !== 0;
		assert.deepEqual(page.size, sideways ? { w: 600, h: 400 } : { w: 400, h: 600 });
		assert.equal(page.text, "Rotated line of text");
		const rects = page.rects(0, page.text.length);
		assert.ok(rects.length > 0, `page ${i} has rects`);
		const l = Math.min(...rects.map((r) => r.x));
		const t = Math.min(...rects.map((r) => r.y));
		const r = Math.max(...rects.map((q) => q.x + q.w));
		const b = Math.max(...rects.map((q) => q.y + q.h));
		assert.ok(l >= 0 && t >= 0 && r <= page.size.w + 0.5 && b <= page.size.h + 0.5, `page ${i} rects inside the page`);
		// Upright text runs along x; on a quarter-turned page it runs along y.
		assert.equal(r - l > b - t, !sideways, `page ${i} orientation`);
	}
	doc.close();
});

test("documents are independent and close frees them", async () => {
	const a = pdfium.open(paper);
	const pdf = await PDFDocument.create();
	pdf.addPage().drawText("second document", { x: 50, y: 700, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
	const b = pdfium.open(await pdf.save());
	assert.equal(b.pageText(0).text, "second document");
	assert.ok(a.pageText(0).text.length > 100);
	a.close();
	b.close();
	assert.throws(() => a.pageText(0), /closed/);
	const before = a.heapBytes();
	for (let i = 0; i < 20; i++) {
		const d = pdfium.open(paper);
		for (let p = 0; p < d.pageCount; p++) d.pageText(p);
		d.close();
	}
	assert.equal(a.heapBytes(), before, "heap does not grow across open/close cycles");
});

test("broken and encrypted input", () => {
	assert.throws(
		() => pdfium.open(new TextEncoder().encode("%PDF-1.7\nnot really a pdf")),
		(e: unknown) => e instanceof EngineError && e.code === "parse",
	);
	const doc = pdfium.open(paper);
	assert.throws(() => doc.pageText(doc.pageCount), RangeError);
	doc.close();
});
