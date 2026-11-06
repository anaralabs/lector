import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
	type Box,
	detectFigures,
	type FigureLine,
	figureAt,
	findCaptions,
	linesFromChars,
	type PageFigure,
	readFigureLines,
	readFigureObjects,
} from "../src/figures.ts";

const require = createRequire(import.meta.url);
const W = 612;
const H = 792;
const line = (
	text: string,
	x: number,
	y: number,
	w = 400,
	h = 10,
): FigureLine => ({ text, box: [x, y, x + w, y + h] });
const grid = (
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	n: number,
): Box[] => {
	const out: Box[] = [];
	for (let i = 0; i < n; i++) {
		const x = x0 + ((x1 - x0 - 6) * (i % 10)) / 9;
		const y =
			y0 +
			((y1 - y0 - 6) * Math.floor(i / 10)) / Math.max(1, Math.ceil(n / 10) - 1);
		out.push([x, y, x + 6, y + 6]);
	}
	return out;
};

test("lines: chars group into lines, generated spaces join words, newlines split", () => {
	const chars = "Fig 1\nab";
	const codes = [...chars].map((c) => c.codePointAt(0)!);
	const boxes = [
		0, 0, 5, 10, 5, 0, 10, 10, 10, 0, 15, 10, 0, 0, 0, 0, 20, 0, 25, 10, 0, 0,
		0, 0, 0, 20, 5, 30, 5, 20, 10, 30,
	];
	assert.deepEqual(
		linesFromChars(codes, boxes).map((l) => l.text),
		["Fig 1", "ab"],
	);
});

test("captions: label, continuation lines, and in-text references that are not captions", () => {
	const caps = findCaptions([
		line("Figure 3: The Transformer - model archi-", 100, 400),
		line("tecture.", 100, 411, 60),
		line("As shown in Figure 3 the model works.", 100, 440),
		line("Table 2. Results", 100, 600),
		line("FIG. 4 Growth curves", 100, 700),
	]);
	assert.deepEqual(
		caps.map((c) => [c.label, c.table, c.strong]),
		[
			["Figure 3", false, true],
			["Table 2", true, true],
			["FIG. 4", false, false],
		],
	);
	assert.equal(
		caps[0]!.text,
		"Figure 3: The Transformer - model architecture.",
	);
});

test("a vector plot takes its caption below, tick labels, and not the caption", () => {
	const [fig, ...rest] = detectFigures({
		page: 0,
		w: W,
		h: H,
		images: [],
		paths: [[120, 100, 480, 300], ...grid(130, 110, 470, 290, 60)],
		lines: [
			line("0.5", 100, 290, 14),
			line("Epoch", 280, 312, 30),
			line("Figure 1: Loss over training.", 72, 330, 468),
			line(
				"Body text continues here at full column width, as usual.",
				72,
				380,
				468,
			),
		],
	});
	assert.equal(rest.length, 0);
	assert.equal(fig!.kind, "vector");
	assert.equal(fig!.label, "Figure 1");
	assert.equal(fig!.caption!.text, "Figure 1: Loss over training.");
	assert.ok(
		fig!.rect.x <= 100 && fig!.rect.y + fig!.rect.h >= 322,
		"absorbs tick and axis labels",
	);
	assert.ok(fig!.rect.y + fig!.rect.h < 330, "stops above the caption");
});

test("sub-panels side by side share one caption", () => {
	const figs = detectFigures({
		page: 0,
		w: W,
		h: H,
		images: [
			[150, 100, 250, 260],
			[350, 100, 470, 280],
		],
		paths: [],
		lines: [line("Figure 2: (left) A. (right) B.", 100, 300, 420)],
	});
	assert.equal(figs.length, 1);
	assert.equal(figs[0]!.kind, "image");
	assert.deepEqual([figs[0]!.rect.x, figs[0]!.rect.w], [150, 320]);
});

test("a booktabs table: separate rules with text between, caption above", () => {
	const figs = detectFigures({
		page: 0,
		w: W,
		h: H,
		images: [],
		paths: [
			[100, 120, 500, 121],
			[100, 135, 500, 135.5],
			[100, 220, 500, 221],
		],
		lines: [
			line("Table 1: Scores.", 100, 100),
			line("Model BLEU", 110, 124, 300),
			line("Base 27.3", 110, 140, 300),
			line("Big 28.4", 110, 152, 300),
		],
	});
	assert.equal(figs.length, 1);
	assert.equal(figs[0]!.kind, "table");
	assert.equal(figs[0]!.label, "Table 1");
	assert.deepEqual(
		[figs[0]!.rect.y, figs[0]!.rect.y + figs[0]!.rect.h],
		[120, 221],
	);
});

test("not figures: lone rules, a framed paragraph box, page-sized scans, banners", () => {
	const para = [0, 1, 2, 3].map((i) =>
		line(
			"A long abstract sentence that fills the shaded box width.",
			80,
			110 + i * 12,
			440,
		),
	);
	assert.deepEqual(
		detectFigures({
			page: 0,
			w: W,
			h: H,
			images: [[0, 0, W, H * 0.8]],
			paths: [
				[72, 700, 200, 700.5],
				[70, 100, 530, 170],
				...grid(75, 105, 525, 165, 10),
				[56, 20, 540, 60],
				...grid(60, 25, 530, 55, 10),
			],
			lines: para,
		}),
		[],
	);
});

test("figureAt: the smallest figure under the point", () => {
	const figs: PageFigure[] = [
		{ page: 0, kind: "vector", rect: { x: 0, y: 0, w: 100, h: 100 } },
		{ page: 0, kind: "image", rect: { x: 10, y: 10, w: 20, h: 20 } },
	];
	assert.equal(figureAt(figs, 15, 15)?.kind, "image");
	assert.equal(figureAt(figs, 50, 50)?.kind, "vector");
	assert.equal(figureAt(figs, 150, 50), null);
});

test("attention-is-all-you-need: every figure and table found with its label", async () => {
	const { init } = await import(
		require.resolve("@embedpdf/pdfium").replace(/index\.cjs$/, "index.js")
	);
	const P = await init({
		wasmBinary: readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")),
	});
	P.PDFiumExt_Init();
	const bytes = readFileSync(
		new URL(
			"../../docs/public/pdf/attention-is-all-you-need.pdf",
			import.meta.url,
		),
	);
	const heap = () => (P.pdfium as { HEAPU8: Uint8Array }).HEAPU8;
	const ptr = P.pdfium.wasmExports.malloc(bytes.length);
	heap().set(bytes, ptr);
	const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
	const found: string[] = [];
	for (let i = 0; i < P.FPDF_GetPageCount(doc); i++) {
		const page = P.FPDF_LoadPage(doc, i);
		const w = P.FPDF_GetPageWidthF(page);
		const h = P.FPDF_GetPageHeightF(page);
		const out = P.pdfium.wasmExports.malloc(8);
		const toPage = (x: number, y: number): [number, number] => {
			P.FPDF_PageToDevice(
				page,
				0,
				0,
				Math.round(w * 64),
				Math.round(h * 64),
				0,
				x,
				y,
				out,
				out + 4,
			);
			const v = new Int32Array(heap().buffer, out, 2);
			return [v[0]! / 64, v[1]! / 64];
		};
		const ctx = { P, heap, toPage };
		for (const f of detectFigures({
			page: i,
			w,
			h,
			...readFigureObjects(ctx, page),
			lines: readFigureLines(ctx, page),
		}))
			found.push(`p${i + 1} ${f.kind} ${f.label ?? "-"}`);
		P.pdfium.wasmExports.free(out);
		P.FPDF_ClosePage(page);
	}
	assert.deepEqual(found, [
		"p3 image Figure 1",
		"p4 image Figure 2",
		"p6 table Table 1",
		"p8 table Table 2",
		"p9 table Table 3",
		"p10 table Table 4",
		"p13 vector Figure 3",
		"p14 vector Figure 4",
		"p15 vector Figure 5",
	]);
});
