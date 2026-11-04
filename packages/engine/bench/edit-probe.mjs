// Edits real PDFs in Node with the full PDFium build and reports what works:
//   node --experimental-strip-types bench/edit-probe.mjs <out-dir> file.pdf...
// Per file: text objects and fonts, same-font vs fallback text edits, delete/add/rotate/delete-page,
// undo/redo, save (full + incremental) timings and sizes; writes the edited PDFs to <out-dir>.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { init } from "@embedpdf/pdfium";
import { Editor } from "../src/edit.ts";

const require = createRequire(import.meta.url);
const [outDir, ...files] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const P = await init({ wasmBinary: readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")) });
P.PDFiumExt_Init();
const heap = () => P.pdfium.HEAPU8;
const now = () => performance.now();

/** Node stand-in for the raster worker's page cache and transforms. */
function openDoc(bytes) {
	const ptr = P.pdfium.wasmExports.malloc(bytes.length);
	heap().set(bytes, ptr);
	const st = { doc: 0, pages: new Map(), xf: new Map() };
	const load = () => {
		st.doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
		if (!st.doc) throw new Error(`open failed ${P.FPDF_GetLastError()}`);
	};
	load();
	const size = (i) => {
		const m = P.pdfium.wasmExports.malloc(8);
		P.FPDF_GetPageSizeByIndexF(st.doc, i, m);
		const f = new Float32Array(heap().buffer, m, 2);
		const r = { w: f[0], h: f[1] };
		P.pdfium.wasmExports.free(m);
		return r;
	};
	const page = (i) => {
		let p = st.pages.get(i);
		if (!p) {
			p = P.FPDF_LoadPage(st.doc, i);
			st.pages.set(i, p);
		}
		return p;
	};
	const affine = (i) => {
		let a = st.xf.get(i);
		if (a) return a;
		const pg = page(i);
		const { w, h } = size(i);
		const K = 64;
		const out = P.pdfium.wasmExports.malloc(8);
		const map = (x, y) => {
			P.FPDF_PageToDevice(pg, 0, 0, Math.round(w * K), Math.round(h * K), 0, x, y, out, out + 4);
			const v = new Int32Array(heap().buffer, out, 2);
			return [v[0] / K, v[1] / K];
		};
		const o = map(0, 0);
		const ax = map(1000, 0);
		const ay = map(0, 1000);
		P.pdfium.wasmExports.free(out);
		a = [(ax[0] - o[0]) / 1000, (ax[1] - o[1]) / 1000, (ay[0] - o[0]) / 1000, (ay[1] - o[1]) / 1000, o[0], o[1]];
		st.xf.set(i, a);
		return a;
	};
	const host = {
		P,
		doc: () => st.doc,
		pageCount: () => P.FPDF_GetPageCount(st.doc),
		page,
		toPage: (i, x, y) => {
			const [a, b, c, d, e, f] = affine(i);
			return [e + a * x + c * y, f + b * x + d * y];
		},
		toUser: (i, x, y) => {
			const [a, b, c, d, e, f] = affine(i);
			const det = a * d - b * c;
			const X = x - e;
			const Y = y - f;
			return [(d * X - c * Y) / det, (-b * X + a * Y) / det];
		},
		resized: (i) => st.xf.delete(i),
		removed: (i) => {
			const p = st.pages.get(i);
			if (p) P.FPDF_ClosePage(p);
			const next = new Map();
			for (const [k, v] of st.pages) if (k !== i) next.set(k > i ? k - 1 : k, v);
			st.pages = next;
			st.xf.clear();
		},
		reopen: () => {
			for (const p of st.pages.values()) P.FPDF_ClosePage(p);
			st.pages.clear();
			st.xf.clear();
			P.FPDF_CloseDocument(st.doc);
			load();
		},
	};
	return { host, st, size };
}

function render(st, index, scale = 1) {
	const pg = st.pages.get(index) ?? P.FPDF_LoadPage(st.doc, index);
	const m = P.pdfium.wasmExports.malloc(8);
	P.FPDF_GetPageSizeByIndexF(st.doc, index, m);
	const [w, h] = new Float32Array(heap().buffer, m, 2);
	P.pdfium.wasmExports.free(m);
	const W = Math.round(w * scale);
	const H = Math.round(h * scale);
	const bmp = P.FPDFBitmap_Create(W, H, 1);
	P.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff);
	const t0 = now();
	P.FPDF_RenderPageBitmap(bmp, pg, 0, 0, W, H, 0, 0x10);
	const ms = now() - t0;
	P.FPDFBitmap_Destroy(bmp);
	if (!st.pages.has(index)) P.FPDF_ClosePage(pg);
	return ms;
}

const results = [];
for (const file of files) {
	const bytes = readFileSync(file);
	const name = basename(file, ".pdf");
	const t0 = now();
	const { host, st } = openDoc(bytes);
	const openMs = now() - t0;
	const ed = new Editor(host);
	const r = { file: name, sizeKB: Math.round(bytes.length / 1024), pages: host.pageCount(), openMs: +openMs.toFixed(1) };
	const pageIndex = 0;
	let t = now();
	const objs = ed.objects(pageIndex);
	r.objectsMs = +(now() - t).toFixed(1);
	const text = objs.filter((o) => o.type === "text" && o.text?.trim());
	r.objects = objs.length;
	r.types = Object.fromEntries(Object.entries(objs.reduce((m, o) => ((m[o.type] = (m[o.type] ?? 0) + 1), m), {})));
	r.textObjects = text.length;
	r.charsPerTextObj = text.length ? +(text.reduce((s, o) => s + o.text.length, 0) / text.length).toFixed(1) : 0;
	r.fonts = [...new Set(text.map((o) => `${o.font}${o.embedded ? "" : " (not embedded)"}`))].slice(0, 8);
	r.invisibleText = text.filter((o) => o.invisible).length;
	r.renderMs = +render(st, pageIndex, 2).toFixed(1);

	// set-text on up to 30 objects: same chars reversed-cased word (common glyphs) vs. a foreign word
	const sample = text.filter((o) => o.text.trim().length >= 3).slice(0, 30);
	const tally = { same: 0, fallback: 0, failed: 0, foreignSame: 0, foreignFallback: 0, foreignFailed: 0 };
	const editMs = [];
	for (const o of sample) {
		const swapped = [...o.text].reverse().join("");
		try {
			t = now();
			const out = ed.apply({ kind: "set-text", page: pageIndex, obj: o.index, text: swapped });
			editMs.push(now() - t);
			tally[out.font === "same" ? "same" : "fallback"]++;
		} catch (e) {
			tally.failed++;
			r.failReason ??= String(e.message);
		}
		ed.undo();
	}
	for (const o of sample.slice(0, 10)) {
		try {
			const out = ed.apply({ kind: "set-text", page: pageIndex, obj: o.index, text: "Quarterly zebra 42 jumps" });
			tally[out.font === "same" ? "foreignSame" : "foreignFallback"]++;
		} catch (e) {
			tally.foreignFailed++;
			r.foreignFailReason ??= String(e.message);
		}
		ed.undo();
	}
	r.setText = tally;
	editMs.sort((a, b) => a - b);
	r.setTextMs = editMs.length ? { p50: +editMs[editMs.length >> 1].toFixed(2), max: +editMs[editMs.length - 1].toFixed(2) } : null;

	// one kept edit of each kind, then undo/redo timings
	const ops = [];
	if (sample[0]) ops.push({ kind: "set-text", page: 0, obj: sample[0].index, text: "EDITED by lector" });
	ops.push({ kind: "add-text", page: 0, x: 72, y: 60, text: "Added note — 2026", size: 14, color: [200, 0, 0] });
	const victim = objs.find((o) => o.type === "image") ?? objs.find((o) => o.type === "path");
	if (victim) ops.push({ kind: "delete-object", page: 0, obj: victim.index });
	if (sample[1]) ops.push({ kind: "move-object", page: 0, obj: sample[1].index, dx: 20, dy: 10 });
	ops.push({ kind: "redact", page: 0, rect: [72, 100, 300, 160] });
	if (host.pageCount() > 1) ops.push({ kind: "rotate-page", page: 1, quarter: 1 });
	if (host.pageCount() > 2) ops.push({ kind: "delete-page", page: 2 });
	r.ops = {};
	for (const op of ops) {
		t = now();
		try {
			const out = ed.apply(op);
			r.ops[op.kind] = { ms: +(now() - t).toFixed(2), font: out.font, widthDelta: out.widthDelta?.toFixed(1) };
		} catch (e) {
			r.ops[op.kind] = { error: String(e.message) };
		}
	}
	r.repaintMs = +render(st, 0, 2).toFixed(1);
	t = now();
	ed.undo();
	r.undoLastMs = +(now() - t).toFixed(2);
	t = now();
	ed.redo();
	r.redoLastMs = +(now() - t).toFixed(2);
	// undo the set-text (replay) by going back to depth 0 and forward again
	t = now();
	while (ed.canUndo) ed.undo();
	r.undoAllMs = +(now() - t).toFixed(2);
	t = now();
	while (ed.canRedo) ed.redo();
	r.redoAllMs = +(now() - t).toFixed(2);

	for (const inc of [false, true]) {
		t = now();
		const out = ed.save(inc);
		const key = inc ? "saveIncremental" : "saveFull";
		r[key] = { ms: +(now() - t).toFixed(1), KB: Math.round(out.length / 1024) };
		writeFileSync(join(outDir, `${name}.${inc ? "inc" : "full"}.pdf`), out);
		// reopen in a fresh PDFium document and check the edit stuck
		const back = openDoc(out);
		const e2 = new Editor(back.host);
		const texts = e2.objects(0).filter((o) => o.type === "text").map((o) => o.text);
		r[key].reopened = { pages: back.host.pageCount(), hasEdit: texts.some((x) => x?.includes("EDITED")), hasAdded: texts.some((x) => x?.includes("Added note")) };
	}
	results.push(r);
	console.log(JSON.stringify(r));
}
writeFileSync(join(outDir, "probe.json"), JSON.stringify(results, null, 2));
