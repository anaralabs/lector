// PDFium page text in Node, as the raster worker extracts it (codes + loose boxes, top-left points).
// Usage: node test/fixtures/pdfium-text.mjs <file.pdf> <out.json> [pages, e.g. 0,1]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { init } from "@embedpdf/pdfium";

let ready = null;
const pdfium = () => {
	ready ??= (async () => {
		const require = createRequire(import.meta.url);
		const P = await init({ wasmBinary: readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")) });
		P.PDFiumExt_Init();
		return P;
	})();
	return ready;
};

/** [{ page, w, h, codes: Uint32Array, boxes: Float32Array }] for the given (default: all) pages. */
export async function extractText(bytes, pages) {
	const P = await pdfium();
	const { malloc, free } = P.pdfium.wasmExports;
	const ptr = malloc(bytes.length);
	P.pdfium.HEAPU8.set(bytes, ptr);
	const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
	if (!doc) throw new Error("PDFium cannot open the document");
	const which = pages ?? Array.from({ length: P.FPDF_GetPageCount(doc) }, (_, i) => i);
	const rect = malloc(16);
	const out = [];
	for (const n of which) {
		const page = P.FPDF_LoadPage(doc, n);
		const w = P.FPDF_GetPageWidthF(page);
		const h = P.FPDF_GetPageHeightF(page);
		const tp = P.FPDFText_LoadPage(page);
		const len = P.FPDFText_CountChars(tp);
		const codes = new Uint32Array(len);
		const boxes = new Float32Array(len * 4);
		for (let i = 0; i < len; i++) {
			codes[i] = P.FPDFText_GetUnicode(tp, i);
			if (P.FPDFText_IsGenerated(tp, i) || !P.FPDFText_GetLooseCharBox(tp, i, rect)) continue;
			const r = new Float32Array(P.pdfium.HEAPU8.buffer, rect, 4);
			boxes.set([r[0], h - r[1], r[2], h - r[3]], i * 4);
		}
		P.FPDFText_ClosePage(tp);
		P.FPDF_ClosePage(page);
		out.push({ page: n, w, h, codes, boxes });
	}
	free(rect);
	P.FPDF_CloseDocument(doc);
	free(ptr);
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [file, dest, pages] = process.argv.slice(2);
	const result = await extractText(readFileSync(file), pages?.split(",").map(Number));
	const round = (b) => Array.from(b, (v) => Math.round(v * 100) / 100);
	writeFileSync(dest, JSON.stringify(result.map((p) => ({ ...p, codes: Array.from(p.codes), boxes: round(p.boxes) }))));
	console.log(`${result.length} pages -> ${dest}`);
}
