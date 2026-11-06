/// <reference types="node" />
// Server-side text with the viewer's own PDFium build and text model: a
// character range computed here selects the same text in the viewer.

import { readFile } from "node:fs/promises";
import { pageTransform, readCharBoxes } from "./char-boxes";
import { EngineError } from "./errors";
import { init, type Pdfium } from "./pdfium/pdfium.js";
import type { PageSize } from "./protocol";
import { openErrorCode } from "./range";
import { PageText, type Rect } from "./text";

export { EngineError } from "./errors";
export type { ErrorCode, PageSize } from "./protocol";
export { type Line, PageText, type Rect, type SelectionTextOptions } from "./text";

export interface LoadPdfiumOptions {
	/** pdfium.wasm as bytes, a compiled module, or a file path; defaults to the copy next to this file */
	wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module | string;
}

export interface OpenOptions {
	password?: string;
}

/** One page's text, exactly as the viewer's `pageTextMap(page)` sees it. */
export interface PdfPageText {
	/** 0-based page index */
	page: number;
	/** page points as displayed (rotation applied), top-left origin */
	size: PageSize;
	/** the viewer's page text (`pageTextMap().text`): offsets into it are citation ranges */
	text: string;
	/** PDFium char index of each UTF-16 unit of `text` (`pageTextMap().chars`) */
	chars: Int32Array;
	/** the viewer's text model for this page (lines, hit testing, selection rects) */
	model: PageText;
	/** Selection rects, as the viewer draws them, for `text` offsets [start, end). */
	rects(start: number, end: number): Rect[];
}

export interface PdfDocument {
	readonly pageCount: number;
	pageSize(page: number): PageSize;
	pageText(page: number): PdfPageText;
	/** bytes held by the WASM heap (all documents of this instance) */
	heapBytes(): number;
	close(): void;
}

export interface PdfiumText {
	open(bytes: Uint8Array, options?: OpenOptions): PdfDocument;
}

type Emscripten = { HEAPU8: Uint8Array; addFunction: (f: (...a: number[]) => number, sig: string) => number };

async function wasmSource(wasm: LoadPdfiumOptions["wasm"]): Promise<Uint8Array | ArrayBuffer | WebAssembly.Module> {
	if (wasm === undefined) return readFile(new URL("./pdfium.wasm", import.meta.url));
	if (typeof wasm === "string") return readFile(wasm);
	return wasm;
}

/** Starts one PDFium WASM instance. Documents opened on it share its heap and run one call at a time. */
export async function loadPdfium(options: LoadPdfiumOptions = {}): Promise<PdfiumText> {
	const source = await wasmSource(options.wasm);
	const P: Pdfium = await init({
		instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
			const ready: Promise<WebAssembly.WebAssemblyInstantiatedSource> =
				source instanceof WebAssembly.Module
					? WebAssembly.instantiate(source, imports).then((instance) => ({ instance, module: source }))
					: WebAssembly.instantiate(source as BufferSource, imports);
			ready.then(({ instance, module }) => receive(instance, module));
			return {};
		},
	});
	P.PDFiumExt_Init();
	const em = P.pdfium as unknown as Emscripten;
	const heap = () => em.HEAPU8;
	const { malloc, free } = P.pdfium.wasmExports;
	const files = new Map<number, Uint8Array>();
	let nextFile = 1;
	// int GetBlock(void* param, unsigned long position, unsigned char* buf, unsigned long size)
	const getBlock = em.addFunction((param: number, position: number, buf: number, size: number) => {
		const bytes = files.get(param);
		const start = position >>> 0;
		const end = start + (size >>> 0);
		if (!bytes || end > bytes.length) return 0;
		heap().set(bytes.subarray(start, end), buf);
		return 1;
	}, "iiiii");

	return {
		open(bytes, { password } = {}) {
			const id = nextFile++;
			files.set(id, bytes);
			// FPDF_FILEACCESS { unsigned long m_FileLen; GetBlock* m_GetBlock; void* m_Param; }
			const access = malloc(12);
			new Uint32Array(heap().buffer, access, 3).set([bytes.length, getBlock, id]);
			const doc = P.FPDF_LoadCustomDocument(access, password ?? "");
			if (!doc) {
				const code = openErrorCode(P.FPDF_GetLastError(), false);
				files.delete(id);
				free(access);
				throw new EngineError(`PDFium could not open the document (${code})`, code, "document-load");
			}
			const pageCount = P.FPDF_GetPageCount(doc);
			const sizes: PageSize[] = [];
			let closed = false;
			const pageSize = (page: number): PageSize => {
				let size = sizes[page];
				if (!size) {
					const mem = malloc(8);
					P.FPDF_GetPageSizeByIndexF(doc, page, mem);
					const wh = new Float32Array(heap().buffer, mem, 2);
					size = { w: wh[0]!, h: wh[1]! };
					free(mem);
					sizes[page] = size;
				}
				return size;
			};
			return {
				pageCount,
				pageSize,
				heapBytes: () => heap().length,
				pageText(page) {
					if (closed) throw new Error("lector-engine: document is closed");
					if (!(page >= 0 && page < pageCount)) throw new RangeError(`page ${page} out of range (0..${pageCount - 1})`);
					const size = pageSize(page);
					const handle = P.FPDF_LoadPage(doc, page);
					if (!handle) throw new EngineError(`PDFium could not load page ${page}`, "parse", "text");
					let codes: Uint32Array;
					let boxes: Float32Array;
					try {
						({ codes, boxes } = readCharBoxes(P, heap, handle, pageTransform(P, heap, handle, size.w, size.h).xf));
					} finally {
						P.FPDF_ClosePage(handle);
					}
					const model = new PageText(codes, boxes, size.h);
					const { text, chars } = model.textWithMap();
					return {
						page,
						size,
						text,
						chars,
						model,
						rects(start, end) {
							if (end <= start) return [];
							const from = chars[start] ?? 0;
							return model.rects(from, (chars[end - 1] ?? from) + 1);
						},
					};
				},
				close() {
					if (closed) return;
					closed = true;
					P.FPDF_CloseDocument(doc);
					files.delete(id);
					free(access);
				},
			};
		},
	};
}
