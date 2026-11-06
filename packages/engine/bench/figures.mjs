// Runs figure detection over PDFs and writes an overlay PNG per page with figures.
// node --experimental-strip-types bench/figures.mjs out-dir a.pdf b.pdf ...
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import * as mupdf from "mupdf";
import { detectFigures, readFigureLines, readFigureObjects } from "../src/figures.ts";

const require = createRequire(import.meta.url);
const [out, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const { init } = await import(require.resolve("@embedpdf/pdfium").replace(/index\.cjs$/, "index.js"));
const P = await init({ wasmBinary: readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")) });
P.PDFiumExt_Init();
const heap = () => P.pdfium.HEAPU8;
const COLORS = { image: [220, 40, 40], vector: [30, 110, 230], table: [20, 160, 60] };
for (const file of files) {
	const bytes = readFileSync(file);
	const ptr = P.pdfium.wasmExports.malloc(bytes.length);
	heap().set(bytes, ptr);
	const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
	const md = mupdf.Document.openDocument(bytes, "application/pdf");
	const n = Math.min(P.FPDF_GetPageCount(doc), Number(process.env.MAX_PAGES ?? 16));
	for (let i = 0; i < n; i++) {
		const page = P.FPDF_LoadPage(doc, i);
		const w = P.FPDF_GetPageWidthF(page);
		const h = P.FPDF_GetPageHeightF(page);
		const mem = P.pdfium.wasmExports.malloc(8);
		const toPage = (x, y) => {
			P.FPDF_PageToDevice(page, 0, 0, Math.round(w * 64), Math.round(h * 64), 0, x, y, mem, mem + 4);
			const v = new Int32Array(heap().buffer, mem, 2);
			return [v[0] / 64, v[1] / 64];
		};
		const ctx = { P, heap, toPage };
		const t0 = performance.now();
		const objs = readFigureObjects(ctx, page);
		const lines = readFigureLines(ctx, page);
		const figs = detectFigures({ page: i, w, h, ...objs, lines });
		const ms = performance.now() - t0;
		P.pdfium.wasmExports.free(mem);
		P.FPDF_ClosePage(page);
		console.log(`${basename(file)} p${i + 1} ${ms.toFixed(1)}ms objs=${objs.images.length}i/${objs.paths.length}p :: ${figs.map((f) => `${f.kind}${f.label ? `[${f.label}]` : ""}@${Math.round(f.rect.x)},${Math.round(f.rect.y)} ${Math.round(f.rect.w)}x${Math.round(f.rect.h)}`).join(" | ")}`);
		if (!figs.length) continue;
		const S = 1.5;
		const pix = md.loadPage(i).toPixmap(mupdf.Matrix.scale(S, S), mupdf.ColorSpace.DeviceRGB, false);
		const pw = pix.getWidth();
		const ph = pix.getHeight();
		const px = pix.getPixels();
		const put = (x, y, c) => {
			if (x < 0 || y < 0 || x >= pw || y >= ph) return;
			px.set(c, (y * pw + x) * 3);
		};
		for (const f of figs) {
			const boxes = [[f.rect, COLORS[f.kind]], ...(f.caption ? [[f.caption.rect, [240, 160, 0]]] : [])];
			for (const [r, c] of boxes) {
				const x0 = Math.round(r.x * S), y0 = Math.round(r.y * S), x1 = Math.round((r.x + r.w) * S), y1 = Math.round((r.y + r.h) * S);
				for (let t = 0; t < 3; t++) {
					for (let x = x0; x <= x1; x++) { put(x, y0 + t, c); put(x, y1 - t, c); }
					for (let y = y0; y <= y1; y++) { put(x0 + t, y, c); put(x1 - t, y, c); }
				}
			}
		}
		writeFileSync(join(out, `${basename(file, ".pdf")}-p${i + 1}.png`), pix.asPNG());
	}
}
