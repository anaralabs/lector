/// <reference lib="webworker" />
// One PDFium WASM instance per worker. Each worker owns its own copy of the
// document, so workers never share memory and need no cross-origin isolation.

import { init } from "@embedpdf/pdfium";
import type { FromRaster, Link, OutlineItem, ToRaster } from "./protocol";

type Pdfium = Awaited<ReturnType<typeof init>>;

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10; // RGBA instead of BGRA
const PAGE_CACHE = 8;

let P: Pdfium;
// Re-read on every use: the WASM heap buffer is replaced when memory grows.
const heap = () => (P.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
let doc = 0;
let port: MessagePort;
const pageSizes: { w: number; h: number }[] = [];
const pages = new Map<number, number>(); // LRU: page index -> FPDF_PAGE

function loadPage(index: number): number {
	const hit = pages.get(index);
	if (hit) {
		pages.delete(index);
		pages.set(index, hit);
		return hit;
	}
	const page = P.FPDF_LoadPage(doc, index);
	pages.set(index, page);
	if (pages.size > PAGE_CACHE) {
		const [oldIndex, oldPage] = pages.entries().next().value as [number, number];
		pages.delete(oldIndex);
		P.FPDF_ClosePage(oldPage);
	}
	return page;
}

function send(msg: FromRaster, transfer: Transferable[] = []) {
	port.postMessage(msg, transfer);
}

function renderTile(msg: Extract<ToRaster, { t: "tile" }>) {
	const t0 = performance.now();
	const page = loadPage(msg.page);
	const size = pageSizes[msg.page]!;
	const { w, h } = msg;
	const bmp = P.FPDFBitmap_Create(w, h, 1);
	P.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
	P.FPDF_RenderPageBitmap(
		bmp,
		page,
		-msg.x,
		-msg.y,
		Math.round(size.w * msg.scale),
		Math.round(size.h * msg.scale),
		0,
		FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER,
	);
	const ptr = P.FPDFBitmap_GetBuffer(bmp);
	const stride = P.FPDFBitmap_GetStride(bmp);
	const mem = heap();
	let buf: ArrayBuffer;
	if (stride === w * 4) {
		buf = mem.slice(ptr, ptr + w * h * 4).buffer;
	} else {
		const out = new Uint8Array(w * h * 4);
		for (let row = 0; row < h; row++) {
			out.set(mem.subarray(ptr + row * stride, ptr + row * stride + w * 4), row * w * 4);
		}
		buf = out.buffer;
	}
	P.FPDFBitmap_Destroy(bmp);
	send({ t: "tile", id: msg.id, buf, w, h, ms: performance.now() - t0 }, [buf]);
}

type Xf = (x: number, y: number) => [number, number];
const transforms = new Map<number, Xf>();

/**
 * PDF user space -> page points with a top-left origin, as displayed: applies
 * /Rotate and the crop box offset (PDFium's own page-to-device mapping).
 */
function transformFor(index: number): Xf {
	const hit = transforms.get(index);
	if (hit) return hit;
	const page = loadPage(index);
	const { w, h } = pageSizes[index]!;
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
	const xf: Xf = (x, y) => [o[0] + a * x + c * y, o[1] + b * x + d * y];
	transforms.set(index, xf);
	return xf;
}

/** Axis-aligned box (l, t, r, b) in page points from a user-space rect. */
function boxFor(xf: Xf, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
	const [ax, ay] = xf(x0, y0);
	const [bx, by] = xf(x1, y1);
	return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

function readDest(dest: number): Link["dest"] {
	if (!dest) return undefined;
	const page = P.FPDFDest_GetDestPageIndex(doc, dest);
	if (page < 0) return undefined;
	// FPDF_BOOL hasX, hasY, hasZoom; FS_FLOAT x, y, zoom
	const mem = P.pdfium.wasmExports.malloc(24);
	let top: number | undefined;
	if (P.FPDFDest_GetLocationInPage(dest, mem, mem + 4, mem + 8, mem + 12, mem + 16, mem + 20)) {
		const ints = new Int32Array(heap().buffer, mem, 3);
		const floats = new Float32Array(heap().buffer, mem + 12, 3);
		if (ints[1] && pageSizes[page]) top = Math.max(0, transformFor(page)(ints[0] ? floats[0]! : 0, floats[1]!)[1]);
	}
	P.pdfium.wasmExports.free(mem);
	return { page, top };
}

function readString(fn: (buf: number, len: number) => number, utf16: boolean) {
	const len = fn(0, 0);
	if (len <= 0) return "";
	const buf = P.pdfium.wasmExports.malloc(len);
	fn(buf, len);
	const bytes = heap().slice(buf, buf + len);
	P.pdfium.wasmExports.free(buf);
	const text = utf16 ? new TextDecoder("utf-16le").decode(bytes) : new TextDecoder().decode(bytes);
	return text.replace(/\0+$/, "");
}

const PDFACTION_GOTO = 1;
const PDFACTION_URI = 3;

function readLinks(page: number, xf: Xf): Link[] {
	const links: Link[] = [];
	const mem = P.pdfium.wasmExports.malloc(4 + 4 + 16);
	const startPos = mem;
	const linkOut = mem + 4;
	const rect = mem + 8;
	new Int32Array(heap().buffer, startPos, 1)[0] = 0;
	while (P.FPDFLink_Enumerate(page, startPos, linkOut)) {
		const link = new Int32Array(heap().buffer, linkOut, 1)[0]!;
		if (!P.FPDFLink_GetAnnotRect(link, rect)) continue;
		const r = new Float32Array(heap().buffer, rect, 4); // left, top, right, bottom (PDF y-up)
		const box: Link["rect"] = boxFor(xf, r[0]!, r[1]!, r[2]!, r[3]!);
		const entry: Link = { rect: box };
		const dest = P.FPDFLink_GetDest(doc, link);
		if (dest) entry.dest = readDest(dest);
		else {
			const action = P.FPDFLink_GetAction(link);
			const type = action ? P.FPDFAction_GetType(action) : 0;
			if (type === PDFACTION_URI) entry.url = readString((b, l) => P.FPDFAction_GetURIPath(doc, action, b, l), false);
			else if (type === PDFACTION_GOTO) entry.dest = readDest(P.FPDFAction_GetDest(doc, action));
		}
		if (entry.url || entry.dest) links.push(entry);
	}
	P.pdfium.wasmExports.free(mem);
	return links;
}

function readOutline(parent: number, depth: number): OutlineItem[] {
	const items: OutlineItem[] = [];
	if (depth > 16) return items;
	for (let bm = P.FPDFBookmark_GetFirstChild(doc, parent); bm; bm = P.FPDFBookmark_GetNextSibling(doc, bm)) {
		const title = readString((b, l) => P.FPDFBookmark_GetTitle(bm, b, l), true);
		let dest = readDest(P.FPDFBookmark_GetDest(doc, bm));
		if (!dest) {
			const action = P.FPDFBookmark_GetAction(bm);
			if (action && P.FPDFAction_GetType(action) === PDFACTION_GOTO) dest = readDest(P.FPDFAction_GetDest(doc, action));
		}
		items.push({ title, dest, children: readOutline(bm, depth + 1) });
		if (items.length > 5000) break;
	}
	return items;
}

function extractText(msg: Extract<ToRaster, { t: "text" }>) {
	const t0 = performance.now();
	const page = loadPage(msg.page);
	const xf = transformFor(msg.page);
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
	const links = readLinks(page, xf);
	send(
		{ t: "text", id: msg.id, page: msg.page, codes, boxes, links, ms: performance.now() - t0 },
		[codes.buffer, boxes.buffer],
	);
}

async function open(msg: Extract<ToRaster, { t: "init" }>) {
	port = msg.port;
	port.onmessage = (ev: MessageEvent<ToRaster>) => {
		try {
			if (ev.data.t === "tile") renderTile(ev.data);
			else if (ev.data.t === "text") extractText(ev.data);
			else if (ev.data.t === "outline") send({ t: "outline", id: ev.data.id, items: readOutline(0, 0) });
		} catch (err) {
			send({ t: "error", message: String((err as Error)?.stack ?? err) });
		}
	};
	const wasmBinary = await (await fetch(msg.wasmUrl)).arrayBuffer();
	P = await init({ wasmBinary });
	P.PDFiumExt_Init();
	const bytes = new Uint8Array(msg.bytes);
	const ptr = P.pdfium.wasmExports.malloc(bytes.length);
	heap().set(bytes, ptr);
	doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
	if (!doc) throw new Error(`PDFium could not open the document (error ${P.FPDF_GetLastError()})`);
	const count = P.FPDF_GetPageCount(doc);
	// Sizes come from the page tree without parsing page content.
	const size = P.pdfium.wasmExports.malloc(8);
	for (let i = 0; i < count; i++) {
		P.FPDF_GetPageSizeByIndexF(doc, i, size);
		const wh = new Float32Array(heap().buffer, size, 2);
		pageSizes.push({ w: wh[0]!, h: wh[1]! });
	}
	P.pdfium.wasmExports.free(size);
	send({ t: "opened", pages: pageSizes });
}

// Hosts may load this module through a wrapper (dynamic import from a blob
// loader), so announce readiness instead of assuming the first message lands.
self.postMessage({ t: "boot" });

self.onmessage = (ev: MessageEvent<ToRaster>) => {
	if (ev.data.t !== "init") return;
	open(ev.data).catch((err) => {
		const message = String((err as Error)?.stack ?? err);
		if (port) send({ t: "error", message });
		else console.error(message);
	});
};
