// Page geometry and char boxes straight from PDFium. The raster worker and the
// Node entry both read text through here, so their PageText is the same.

import type { Pdfium } from "./pdfium/pdfium.js";

export type Xf = (x: number, y: number) => [number, number];

/**
 * PDF user space -> page points with a top-left origin, as displayed: applies
 * /Rotate and the crop box offset (PDFium's own page-to-device mapping).
 * Also returns the inverse.
 */
export function pageTransform(P: Pdfium, heap: () => Uint8Array, page: number, w: number, h: number): { xf: Xf; inverse: Xf } {
	const K = 64; // device units per point: 1/64pt precision from integer output
	const out = P.pdfium.wasmExports.malloc(8);
	const map = (x: number, y: number): [number, number] => {
		P.FPDF_PageToDevice(page, 0, 0, Math.round(w * K), Math.round(h * K), 0, x, y, out, out + 4);
		const v = new Int32Array(heap().buffer, out, 2);
		return [v[0]! / K, v[1]! / K];
	};
	const o = map(0, 0);
	const ax = map(1000, 0);
	const ay = map(0, 1000);
	P.pdfium.wasmExports.free(out);
	const a = (ax[0] - o[0]) / 1000;
	const b = (ax[1] - o[1]) / 1000;
	const c = (ay[0] - o[0]) / 1000;
	const d = (ay[1] - o[1]) / 1000;
	const det = a * d - b * c || 1;
	return {
		xf: (x, y) => [o[0] + a * x + c * y, o[1] + b * x + d * y],
		inverse: (x, y) => [(d * (x - o[0]) - c * (y - o[1])) / det, (a * (y - o[1]) - b * (x - o[0])) / det],
	};
}

/** Axis-aligned box (l, t, r, b) in page points from a user-space rect. */
export function boxFor(xf: Xf, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
	const [ax, ay] = xf(x0, y0);
	const [bx, by] = xf(x1, y1);
	return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/** Unicode code and loose box (l, t, r, b; zero for generated chars) of every char on a loaded page. */
export function readCharBoxes(P: Pdfium, heap: () => Uint8Array, page: number, xf: Xf): { codes: Uint32Array; boxes: Float32Array } {
	const tp = P.FPDFText_LoadPage(page);
	const n = Math.max(0, P.FPDFText_CountChars(tp));
	const codes = new Uint32Array(n);
	const boxes = new Float32Array(n * 4);
	const rect = P.pdfium.wasmExports.malloc(16); // FS_RECTF {left, top, right, bottom}
	const f32 = () => new Float32Array(heap().buffer, rect, 4);
	for (let i = 0; i < n; i++) {
		codes[i] = P.FPDFText_GetUnicode(tp, i);
		if (P.FPDFText_IsGenerated(tp, i)) continue;
		if (!P.FPDFText_GetLooseCharBox(tp, i, rect)) continue;
		const r = f32();
		const [l, t, rr, b] = boxFor(xf, r[0]!, r[1]!, r[2]!, r[3]!);
		boxes[i * 4] = l;
		boxes[i * 4 + 1] = t;
		boxes[i * 4 + 2] = rr;
		boxes[i * 4 + 3] = b;
	}
	P.pdfium.wasmExports.free(rect);
	P.FPDFText_ClosePage(tp);
	return { codes, boxes };
}
