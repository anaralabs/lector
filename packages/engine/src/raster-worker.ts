/// <reference lib="webworker" />
// One PDFium WASM instance per worker. Each worker owns its own copy of the
// document, so workers never share memory and need no cross-origin isolation.

import { init } from "@embedpdf/pdfium";
import type { DocSource, ErrorCode, FromRaster, Link, OutlineItem, ToRaster } from "./protocol";

type Pdfium = Awaited<ReturnType<typeof init>>;

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10; // RGBA instead of BGRA
const PAGE_CACHE = 8;
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_PAGEOBJ_FORM = 5;
const MAX_IMAGES = 256;

let P: Pdfium;
// Re-read on every use: the WASM heap buffer is replaced when memory grows.
const heap = () => (P.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
let doc = 0;
let pageCount = 0;
let port: MessagePort;
const pageSizes: { w: number; h: number }[] = [];
/**
 * Only the first worker reads every page size up front (the core's layout
 * needs them; each one parses a page dictionary, which with range loading can
 * mean a request per page). The others read sizes as pages are used.
 */
let allSizes = true;
function sizeOf(index: number) {
	let size = pageSizes[index];
	if (!size) {
		const mem = P.pdfium.wasmExports.malloc(8);
		P.FPDF_GetPageSizeByIndexF(doc, index, mem);
		const wh = new Float32Array(heap().buffer, mem, 2);
		size = { w: wh[0]!, h: wh[1]! };
		P.pdfium.wasmExports.free(mem);
		pageSizes[index] = size;
	}
	return size;
}
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
	const size = sizeOf(msg.page);
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
	send({ t: "tile", id: msg.id, buf, w, h, ms: performance.now() - t0, heap: heapBytes() }, [buf]);
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
	const { w, h } = sizeOf(index);
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
		if (ints[1] && page < pageCount) top = Math.max(0, transformFor(page)(ints[0] ? floats[0]! : 0, floats[1]!)[1]);
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
	const { images, scans } = readImages(page, msg.page, xf);
	send(
		{ t: "text", id: msg.id, page: msg.page, codes, boxes, links, images, scans, ms: performance.now() - t0, heap: heapBytes() },
		[codes.buffer, boxes.buffer, images.buffer],
	);
}

type Matrix = [number, number, number, number, number, number];

/** m then n, PDF [a b c d e f] convention */
function concat(m: Matrix, n: Matrix): Matrix {
	return [
		n[0] * m[0] + n[2] * m[1],
		n[1] * m[0] + n[3] * m[1],
		n[0] * m[2] + n[2] * m[3],
		n[1] * m[2] + n[3] * m[3],
		n[0] * m[4] + n[2] * m[5] + n[4],
		n[1] * m[4] + n[3] * m[5] + n[5],
	];
}

// Scan detection (ported from @anaralabs/lector's scan-invert policy). A scanned
// page is one big near-white image; leaving it untoned would keep a bright
// white page in dark mode. Images that paper the page and look like ink on
// paper are tone-mapped with the vector content; photos keep their colours.
/** painted area relative to the page above which one image "papers the page" */
const SCAN_COVERAGE_MIN = 0.7;
/** strip/grid-encoded scans: smallest tile, and how densely the tiles fill their union box */
const SCAN_TILE_MIN_FRACTION = 0.005;
const SCAN_TILE_DENSITY_MIN = 0.85;
const SCAN_WHITE_MIN_FRACTION = 0.6;
const SCAN_OPAQUE_MIN_FRACTION = 0.99;
const SCAN_SATURATED_MAX_FRACTION = 0.15;
const SCAN_SAMPLE_PX = 64;
const SCAN_MAX_TILES = 64;
const FPDFBitmap_Gray = 1;
const FPDFBitmap_BGR = 2;
const FPDFBitmap_BGRx = 3;
const FPDFBitmap_BGRA = 4;

/**
 * Paper verdict for one image: null when it is not paper (photo, colourful,
 * cut-out), else whether it carries dark ink. Samples a block-averaged ~64px
 * grid of the image as painted (masks applied), like lector's drawImage downsample.
 */
function classifyPaper(page: number, obj: number): { inked: boolean } | null {
	let bmp = P.FPDFImageObj_GetRenderedBitmap(doc, page, obj);
	if (!bmp) bmp = P.FPDFImageObj_GetBitmap(obj);
	if (!bmp) return null;
	try {
		const w = P.FPDFBitmap_GetWidth(bmp);
		const h = P.FPDFBitmap_GetHeight(bmp);
		const stride = P.FPDFBitmap_GetStride(bmp);
		const format = P.FPDFBitmap_GetFormat(bmp);
		const bpp = format === FPDFBitmap_Gray ? 1 : format === FPDFBitmap_BGR ? 3 : format === FPDFBitmap_BGRx || format === FPDFBitmap_BGRA ? 4 : 0;
		if (w <= 0 || h <= 0 || !bpp) return null;
		const ptr = P.FPDFBitmap_GetBuffer(bmp);
		const mem = heap();
		const scale = Math.min(1, SCAN_SAMPLE_PX / Math.max(w, h));
		const gw = Math.max(1, Math.round(w * scale));
		const gh = Math.max(1, Math.round(h * scale));
		// Block sums: r, g, b, alpha, count
		const acc = new Float64Array(gw * gh * 5);
		// Reading every pixel of a big rendered image is wasteful: step so each block gets ~16x16 reads.
		const step = Math.max(1, Math.floor(Math.max(w / gw, h / gh) / 16));
		for (let y = 0; y < h; y += step) {
			const by = Math.min(gh - 1, Math.floor(y * scale));
			const row = ptr + y * stride;
			for (let x = 0; x < w; x += step) {
				const bx = Math.min(gw - 1, Math.floor(x * scale));
				const o = row + x * bpp;
				const k = (by * gw + bx) * 5;
				if (bpp === 1) {
					acc[k] += mem[o]!;
					acc[k + 1] += mem[o]!;
					acc[k + 2] += mem[o]!;
					acc[k + 3] += 255;
				} else {
					acc[k] += mem[o + 2]!;
					acc[k + 1] += mem[o + 1]!;
					acc[k + 2] += mem[o]!;
					acc[k + 3] += format === FPDFBitmap_BGRA ? mem[o + 3]! : 255;
				}
				acc[k + 4]++;
			}
		}
		const total = gw * gh;
		let white = 0;
		let opaque = 0;
		let saturated = 0;
		let ink = 0;
		for (let k = 0; k < acc.length; k += 5) {
			const n = acc[k + 4]!;
			if (!n || acc[k + 3]! / n < 250) continue;
			opaque++;
			const r = acc[k]! / n;
			const g = acc[k + 1]! / n;
			const b = acc[k + 2]! / n;
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			if (min > 200 && max - min < 32) white++;
			else if (max > 60 && (max - min) / max > 0.35) saturated++;
			if (max < 100) ink++;
		}
		const paper = opaque / total >= SCAN_OPAQUE_MIN_FRACTION && white / total >= SCAN_WHITE_MIN_FRACTION && saturated / total <= SCAN_SATURATED_MAX_FRACTION;
		return paper ? { inked: ink >= 1 } : null;
	} finally {
		P.FPDFBitmap_Destroy(bmp);
	}
}

interface ImageBox {
	obj: number;
	box: [number, number, number, number];
}

/**
 * Indices of `images` that are scan paper: either one image covering most of
 * the page, or tiles (strips, grids) that together paper it densely. Pages
 * only count as scans when some tile carries ink (a pure-white raster is an
 * MRC background layer or a blank page) and no tile is a photo.
 */
function scanImages(page: number, images: ImageBox[], pw: number, ph: number): Set<number> {
	const area = pw * ph;
	const out = new Set<number>();
	if (!images.length || area <= 0) return out;
	const frac = (b: ImageBox["box"]) => (Math.max(0, Math.min(pw, b[2]) - Math.max(0, b[0])) * Math.max(0, Math.min(ph, b[3]) - Math.max(0, b[1]))) / area;
	let group: number[] = [];
	const big = images.findIndex((im) => frac(im.box) >= SCAN_COVERAGE_MIN);
	if (big >= 0) group = [big];
	else {
		const tiles = images.map((im, i) => i).filter((i) => frac(images[i]!.box) >= SCAN_TILE_MIN_FRACTION);
		if (tiles.length < 2 || tiles.length > SCAN_MAX_TILES) return out;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		let sum = 0;
		for (const i of tiles) {
			const b = images[i]!.box;
			x0 = Math.min(x0, b[0]);
			y0 = Math.min(y0, b[1]);
			x1 = Math.max(x1, b[2]);
			y1 = Math.max(y1, b[3]);
			sum += frac(b);
		}
		const union = frac([x0, y0, x1, y1]);
		if (union < SCAN_COVERAGE_MIN || sum / union < SCAN_TILE_DENSITY_MIN) return out;
		group = tiles;
	}
	let inked = false;
	for (const i of group) {
		const verdict = classifyPaper(page, images[i]!.obj);
		if (!verdict) return out;
		inked ||= verdict.inked;
	}
	if (inked) for (const i of group) out.add(i);
	return out;
}

/**
 * Boxes of the page's raster images, so dark mode can leave photos in their
 * original colours. Stencil masks (1-bit, no colour space) paint with the fill
 * colour like vector shapes, so they are recoloured with the rest, and so are
 * scans (see `scanImages`). `scans` counts the images classified as scan paper.
 */
function readImages(page: number, index: number, xf: Xf): { images: Float32Array; scans: number } {
	const found: ImageBox[] = [];
	const mem = P.pdfium.wasmExports.malloc(28); // FS_MATRIX / 4 bounds / FPDF_IMAGEOBJ_METADATA
	const f32 = () => new Float32Array(heap().buffer, mem, 6);
	const walk = (count: number, get: (i: number) => number, m: Matrix) => {
		for (let i = 0; i < count && found.length < MAX_IMAGES; i++) {
			const obj = get(i);
			const type = P.FPDFPageObj_GetType(obj);
			if (type === FPDF_PAGEOBJ_FORM) {
				if (!P.FPDFPageObj_GetMatrix(obj, mem)) continue;
				const f = f32();
				const child = concat([f[0]!, f[1]!, f[2]!, f[3]!, f[4]!, f[5]!], m);
				walk(P.FPDFFormObj_CountObjects(obj), (j) => P.FPDFFormObj_GetObject(obj, j), child);
				continue;
			}
			if (type !== FPDF_PAGEOBJ_IMAGE) continue;
			if (P.FPDFImageObj_GetImageMetadata(obj, page, mem)) {
				const meta = new Int32Array(heap().buffer, mem, 7);
				if (meta[4] === 1 && meta[5] === 0) continue;
			}
			if (!P.FPDFPageObj_GetBounds(obj, mem, mem + 4, mem + 8, mem + 12)) continue;
			const [l, b, r, t] = f32();
			// Bounds are in the parent form's space; map all four corners to the page.
			let x0 = Infinity;
			let y0 = Infinity;
			let x1 = -Infinity;
			let y1 = -Infinity;
			for (const [cx, cy] of [
				[l!, b!],
				[r!, b!],
				[l!, t!],
				[r!, t!],
			] as const) {
				const [px, py] = xf(m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]);
				x0 = Math.min(x0, px);
				y0 = Math.min(y0, py);
				x1 = Math.max(x1, px);
				y1 = Math.max(y1, py);
			}
			if (x1 - x0 < 1 || y1 - y0 < 1) continue;
			found.push({ obj, box: [x0, y0, x1, y1] });
		}
	};
	walk(P.FPDFPage_CountObjects(page), (i) => P.FPDFPage_GetObject(page, i), [1, 0, 0, 1, 0, 0]);
	P.pdfium.wasmExports.free(mem);
	const size = sizeOf(index);
	const scans = scanImages(page, found, size.w, size.h);
	const out: number[] = [];
	found.forEach((im, i) => {
		if (!scans.has(i)) out.push(...im.box);
	});
	return { images: new Float32Array(out), scans: scans.size };
}

/** FPDF_GetLastError -> ErrorCode */
const LOAD_ERRORS: Record<number, ErrorCode> = { 2: "file", 3: "parse", 4: "password", 5: "security" };

// ---------------------------------------------------------------- byte source
// PDFium pulls bytes through FPDF_LoadCustomDocument's synchronous GetBlock
// callback. Blocks come from a Blob shared by all workers (FileReaderSync) or
// from HTTP range requests (sync XHR, allowed in workers), through a small LRU
// cache. No worker holds a copy of the whole file.
const BLOB_BLOCK = 64 * 1024;
const URL_BLOCK = 256 * 1024;
const CACHE_MAX = 24 * 1024 * 1024;

let source: DocSource | null = null;
let fileLen = 0;
let blockSize = BLOB_BLOCK;
const blocks = new Map<number, Uint8Array>();
let cacheBytes = 0;
let fileAccess = 0;
let reader: FileReaderSync | null = null;

const heapBytes = () => heap().length + cacheBytes;

function fetchBlock(start: number, end: number): Uint8Array {
	const src = source!;
	if (src.kind === "blob") {
		reader ??= new FileReaderSync();
		return new Uint8Array(reader.readAsArrayBuffer(src.blob.slice(start, end)));
	}
	const xhr = new XMLHttpRequest();
	xhr.open("GET", src.url, false);
	xhr.withCredentials = src.credentials;
	xhr.responseType = "arraybuffer";
	xhr.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
	xhr.send();
	const buf = xhr.response as ArrayBuffer | null;
	if (xhr.status === 206 && buf && buf.byteLength === end - start) return new Uint8Array(buf);
	if (xhr.status === 200 && buf && buf.byteLength === fileLen) {
		// The server ignored the range and sent everything: read from that from now on.
		source = { kind: "blob", blob: new Blob([buf]) };
		blockSize = BLOB_BLOCK;
		blocks.clear();
		cacheBytes = 0;
		return new Uint8Array(buf, start, end - start).slice();
	}
	throw new Error(`range request ${start}-${end - 1} failed (HTTP ${xhr.status})`);
}

function block(index: number): Uint8Array {
	const hit = blocks.get(index);
	if (hit) {
		blocks.delete(index);
		blocks.set(index, hit);
		return hit;
	}
	const start = index * blockSize;
	const data = fetchBlock(start, Math.min(fileLen, start + blockSize));
	blocks.set(index, data);
	cacheBytes += data.length;
	while (cacheBytes > CACHE_MAX && blocks.size > 1) {
		const [k, v] = blocks.entries().next().value as [number, Uint8Array];
		blocks.delete(k);
		cacheBytes -= v.length;
	}
	return data;
}

/** int GetBlock(void* param, unsigned long position, unsigned char* buf, unsigned long size) */
function getBlock(_param: number, position: number, buf: number, size: number): number {
	try {
		let pos = position >>> 0;
		let out = buf;
		let left = size >>> 0;
		if (pos + left > fileLen) return 0;
		while (left > 0) {
			const size0 = blockSize;
			const index = Math.floor(pos / size0);
			const data = block(index);
			// `block` may switch the source (and block size): recompute from the new block.
			if (blockSize !== size0) continue;
			const offset = pos - index * blockSize;
			const n = Math.min(left, data.length - offset);
			if (n <= 0) return 0;
			heap().set(data.subarray(offset, offset + n), out);
			pos += n;
			out += n;
			left -= n;
		}
		return 1;
	} catch (err) {
		console.error(`lector-engine: ${String((err as Error)?.message ?? err)}`);
		return 0;
	}
}

function loadDocument(password: string | undefined) {
	if (!fileAccess) {
		// FPDF_FILEACCESS { unsigned long m_FileLen; GetBlock* m_GetBlock; void* m_Param; }
		const fn = (P.pdfium as unknown as { addFunction: (f: (...a: number[]) => number, sig: string) => number }).addFunction(getBlock, "iiiii");
		fileAccess = P.pdfium.wasmExports.malloc(12);
		const view = new Uint32Array(heap().buffer, fileAccess, 3);
		view[0] = fileLen;
		view[1] = fn;
		view[2] = 0;
	}
	doc = P.FPDF_LoadCustomDocument(fileAccess, password ?? "");
	if (!doc) {
		const err = P.FPDF_GetLastError();
		const code = LOAD_ERRORS[err] ?? "unknown";
		const message =
			code === "password"
				? password
					? "Incorrect password: PDFium could not decrypt the document."
					: "The document is password-protected."
				: `PDFium could not open the document (${code === "unknown" ? `error ${err}` : code})`;
		send({ t: "error", message, code, phase: "document-load" });
		return;
	}
	pageCount = P.FPDF_GetPageCount(doc);
	// Sizes come from the page tree without parsing page content.
	if (allSizes) for (let i = 0; i < pageCount; i++) sizeOf(i);
	send({ t: "opened", pages: allSizes ? pageSizes : [] });
}

async function open(msg: Extract<ToRaster, { t: "init" }>) {
	port = msg.port;
	port.onmessage = (ev: MessageEvent<ToRaster>) => {
		const m = ev.data;
		try {
			if (m.t === "tile") renderTile(m);
			else if (m.t === "text") extractText(m);
			else if (m.t === "outline") send({ t: "outline", id: m.id, items: readOutline(0, 0) });
			else if (m.t === "unlock" && P && !doc && fileAccess) loadDocument(m.password);
		} catch (err) {
			const id = "id" in m ? m.id : undefined;
			send({ t: "error", message: String((err as Error)?.stack ?? err), code: "unknown", phase: m.t === "tile" ? "render" : "text", id });
		}
	};
	let wasmBinary: ArrayBuffer;
	try {
		const res = await fetch(msg.wasmUrl);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		wasmBinary = await res.arrayBuffer();
		P = await init({ wasmBinary });
		P.PDFiumExt_Init();
	} catch (err) {
		send({ t: "error", message: `lector-engine: pdfium.wasm failed to load from ${msg.wasmUrl}: ${String((err as Error)?.message ?? err)}`, code: "wasm", phase: "engine-load" });
		return;
	}
	source = msg.source;
	allSizes = msg.sizes !== false;
	if (source.kind === "blob") {
		fileLen = source.blob.size;
		blockSize = BLOB_BLOCK;
	} else {
		fileLen = source.length;
		blockSize = URL_BLOCK;
	}
	loadDocument(msg.password);
}

// Hosts may load this module through a wrapper (dynamic import from a blob
// loader), so announce readiness instead of assuming the first message lands.
self.postMessage({ t: "boot" });

self.onmessage = (ev: MessageEvent<ToRaster>) => {
	if (ev.data.t === "source") {
		// The full file arrived: no more network round-trips. Cached blocks stay valid.
		if (source?.kind === "url" && ev.data.blob.size === fileLen) source = { kind: "blob", blob: ev.data.blob };
		return;
	}
	if (ev.data.t !== "init") return;
	open(ev.data).catch((err) => {
		const message = String((err as Error)?.stack ?? err);
		if (port) send({ t: "error", message, code: "unknown", phase: "document-load" });
		else console.error(message);
	});
};
