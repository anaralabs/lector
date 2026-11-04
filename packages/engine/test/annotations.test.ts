import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { type PdfAnnotation, parsePdfDate, type RawAnnotation, readAnnotations, threadReplies } from "../src/annotations.ts";
// @ts-expect-error plain .mjs script, no types
import { annotated, H, ROTATED_RECT, W, ZOTERO_RECTS } from "../bench/fixtures/make-annotations.mjs";

const require = createRequire(import.meta.url);

test("PDF dates parse to UTC ISO strings, with or without offsets and trailing fields", () => {
	assert.equal(parsePdfDate("D:20151220233213+01'00'"), "2015-12-20T22:32:13.000Z");
	assert.equal(parsePdfDate("D:20231012143000-05'30"), "2023-10-12T20:00:00.000Z");
	assert.equal(parsePdfDate("D:20240311094512Z00'00'"), "2024-03-11T09:45:12.000Z");
	assert.equal(parsePdfDate("D:2024"), "2024-01-01T00:00:00.000Z");
	assert.equal(parsePdfDate("20240102"), "2024-01-02T00:00:00.000Z");
	assert.equal(parsePdfDate("D:20241302"), undefined);
	assert.equal(parsePdfDate("yesterday"), undefined);
	assert.equal(parsePdfDate(undefined), undefined);
});

const raw = (index: number, parent?: number, modified?: string): RawAnnotation => ({
	id: `a${index}`,
	page: 0,
	index,
	kind: "note",
	rect: { x: 0, y: 0, w: 1, h: 1 },
	rects: [],
	opacity: 1,
	contents: `c${index}`,
	modified,
	replies: [],
	parent,
});

test("replies fold into their thread root in date order; orphans and cycles stay top-level", () => {
	const out = threadReplies([raw(0), raw(1, 0, "2024-01-03"), raw(2, 1, "2024-01-02"), raw(3, 9), raw(4, 5), raw(5, 4)]);
	assert.deepEqual(
		out.map((a) => a.id),
		["a0", "a3", "a4", "a5"],
	);
	assert.deepEqual(
		out[0]!.replies.map((r) => r.id),
		["a2", "a1"],
	);
	assert.equal("parent" in out[0]!, false);
});

async function open() {
	const { init } = await import(require.resolve("@embedpdf/pdfium").replace(/index\.cjs$/, "index.js"));
	const P = await init({ wasmBinary: readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")) });
	P.PDFiumExt_Init();
	const bytes: Uint8Array = await annotated();
	const heap = () => (P.pdfium as { HEAPU8: Uint8Array }).HEAPU8;
	const ptr = P.pdfium.wasmExports.malloc(bytes.length);
	heap().set(bytes, ptr);
	const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
	assert.ok(doc);
	return (index: number): PdfAnnotation[] => {
		const page = P.FPDF_LoadPage(doc, index);
		const w = P.FPDF_GetPageWidthF(page);
		const h = P.FPDF_GetPageHeightF(page);
		const out = P.pdfium.wasmExports.malloc(8);
		// the raster worker's mapping: PDFium page-to-device at 64 units per point
		const toPage = (x: number, y: number): [number, number] => {
			P.FPDF_PageToDevice(page, 0, 0, Math.round(w * 64), Math.round(h * 64), 0, x, y, out, out + 4);
			const v = new Int32Array(heap().buffer, out, 2);
			return [v[0]! / 64, v[1]! / 64];
		};
		try {
			return readAnnotations({ P, heap, toPage }, index, page);
		} finally {
			P.pdfium.wasmExports.free(out);
			P.FPDF_ClosePage(page);
		}
	};
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
const sameRect = (r: { x: number; y: number; w: number; h: number }, [x0, y0, x1, y1]: number[], flip = (x: number, y: number) => [x, H - y]) => {
	const [ax, ay] = flip(x0!, y1!);
	const [bx, by] = flip(x1!, y0!);
	const e = { x: Math.min(ax!, bx!), y: Math.min(ay!, by!), w: Math.abs(bx! - ax!), h: Math.abs(by! - ay!) };
	return near(r.x, e.x) && near(r.y, e.y) && near(r.w, e.w) && near(r.h, e.h);
};

test("a Zotero highlight across two columns keeps one rect per quad, its comment, author and colour", async () => {
	const page = await open();
	const [zotero, underline, ...rest] = page(0);
	assert.equal(rest.length, 0, "the popup is not listed");
	assert.equal(zotero!.id, "Zotero-ABCD1234");
	assert.equal(zotero!.kind, "highlight");
	assert.equal(zotero!.author, "Ada Lovelace");
	assert.equal(zotero!.contents, "Key claim: sleep helps recall");
	assert.equal(zotero!.color, "#ffd400");
	assert.equal(zotero!.modified, "2024-03-11T09:45:12.000Z");
	assert.equal(zotero!.rects.length, 3);
	ZOTERO_RECTS.forEach((r: number[], i: number) => assert.ok(sameRect(zotero!.rects[i]!, r), `quad ${i}: ${JSON.stringify(zotero!.rects[i])}`));
	assert.ok(zotero!.rects[2]!.x > W / 2, "the last line is in the right column");
	assert.match(zotero!.text ?? "", /^Sleep after training consolidates decla.* participants recalled more word pairs the next consolidates declarative/);
	assert.doesNotMatch(zotero!.text ?? "", /day Sleep/, "the lines above and below stay out");
	assert.equal(underline!.kind, "underline");
	assert.equal(underline!.contents, undefined);
});

test("an Acrobat comment thread folds its replies; Preview, ink, free text and Anara's note are listed; hidden ones are not", async () => {
	const page = await open();
	const items = page(1);
	assert.deepEqual(
		items.map((a) => a.kind),
		["highlight", "strikeout", "note", "ink", "freetext", "note"],
	);
	const [acrobat, strike, note, ink, free, anara] = items;
	assert.equal(acrobat!.subject, "Highlight");
	assert.equal(acrobat!.opacity.toFixed(1), "0.6");
	assert.equal(acrobat!.modified, "2023-10-12T12:30:00.000Z");
	assert.equal(acrobat!.created, "2023-10-12T12:29:00.000Z");
	assert.deepEqual(
		acrobat!.replies.map((r) => [r.author, r.contents]),
		[
			["Ada Lovelace", "Table 2, second row."],
			["Reviewer 1", "Thanks, found it."],
		],
	);
	assert.equal(strike!.author, "Grace Hopper");
	assert.match(strike!.id, /^obj:\d+$/, "no /NM: the object number identifies it");
	assert.equal(note!.contents, "Compare with Walker 2009");
	assert.equal(ink!.ink?.length, 2);
	assert.equal(ink!.ink![0]!.length, 8);
	assert.ok(near(ink!.ink![1]![1]!, H - 105));
	assert.equal(free!.contents, "See supplementary figure S3");
	assert.equal(anara!.id, "anara:clx0anaraannot01");
});

test("quads on a rotated page map to the page as displayed", async () => {
	const page = await open();
	const [rot] = page(2);
	// /Rotate 90: user (x, y) shows at (y, x)
	assert.ok(
		sameRect(rot!.rects[0]!, ROTATED_RECT, (x, y) => [y, x]),
		JSON.stringify(rot!.rects[0]),
	);
	assert.ok(rot!.rect.w < rot!.rect.h, "a horizontal line of text is vertical once the page turns");
});
