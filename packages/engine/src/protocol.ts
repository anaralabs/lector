// Messages between the viewer core and the PDFium raster workers.
// Coordinates sent to workers are in PDF points with a top-left origin.

import type { PdfAnnotation } from "./annotations";
import type { PageFigure } from "./figures";
import type { FormOp, FormWidget } from "./forms";
import type { TrapKind } from "./wasm-trap";

export interface PageSize {
	w: number;
	h: number;
}

/**
 * What failed. `password`: the document is encrypted and needs a (different)
 * password; `parse`: not a PDF or damaged; `security`: unsupported encryption;
 * `file`: unreadable; `fetch`: the HTTP request failed; `unsupported`: the
 * browser lacks a required feature; `wasm`: pdfium.wasm did not load; `gpu`:
 * no WebGL2 context (blocklisted, or in phase `render`: the context was lost;
 * drawing resumes if the browser restores it); `worker`: a worker script did
 * not load or crashed; `compositor`: the context was lost and no fresh canvas could
 * be drawn on (fall back); `destroyed`: the viewer was destroyed before a request answered;
 * `wasm-trap`: PDFium crashed (a WebAssembly trap or abort) or ran out of memory in every
 * raster worker the engine could start (a crash on one page fails only that page: `page-failed`);
 * `unknown`: anything else.
 */
export type ErrorCode = "password" | "parse" | "security" | "file" | "fetch" | "unsupported" | "wasm" | "gpu" | "compositor" | "worker" | "destroyed" | "wasm-trap" | "unknown";
/** When it failed, like lector's `onError` phases; `request`: a pending viewer request (`pageText`, `outline`, ...). */
export type ErrorPhase = "engine-load" | "document-load" | "render" | "text" | "request";

/**
 * Where a raster worker reads the document from. Workers never hold a full
 * copy: they read blocks on demand, synchronously, as PDFium asks for them.
 * - blob: one Blob shared by every worker (structured clone does not copy it)
 * - url: HTTP range requests (sync XHR) until the main thread posts the whole
 *   file as a Blob (`source` message)
 */
export type DocSource =
	| { kind: "blob"; blob: Blob }
	| {
			kind: "url";
			url: string;
			length: number;
			credentials: boolean;
			/** bytes the main thread already fetched (file head and tail), as [offset, bytes] */
			seeds?: [number, Uint8Array][];
	  };

/**
 * Which page sizes a worker reads before it reports `opened`: every page
 * (`all`), or only these pages (the rest are read later through `sizes` jobs).
 * `fraction`: also the pages around that fraction of the document.
 */
export type SizeHint = { all: true } | { all: false; pages: number[]; fraction?: number };

export type ToRaster =
	/** sizes: omitted for all but one worker (sizes are read as pages are used there) */
	/** lowMemory: cap PDFium's memory lower (a retry after the browser could not reserve it) */
	| { t: "init"; source: DocSource; port: MessagePort; wasmUrl: string; module?: WebAssembly.Module; password?: string; sizes?: SizeHint; lowMemory?: boolean }
	/** sent to the worker itself (not the port): the full file arrived, read from it from now on */
	| { t: "source"; blob: Blob }
	/** sent to the worker itself: the bytes of one range request another worker made */
	| { t: "block"; start: number; data: Uint8Array }
	/** retry opening the document with a password (after a `password` error) */
	| { t: "unlock"; password: string }
	| {
			t: "tile";
			id: number;
			page: number;
			/** device pixels per PDF point */
			scale: number;
			/** tile origin in device pixels, relative to the page's top-left at `scale` */
			x: number;
			y: number;
			w: number;
			h: number;
			/** 2D compositor: apply gamma and the dark tone here (photos keep their colours) and answer with an ImageBitmap */
			bake?: { gamma: number; tone: number[] | null };
			/** render at 1/reduce of the resolution and scale it up (a retry after running out of memory) */
			reduce?: number;
	  }
	| { t: "text"; id: number; page: number }
	| { t: "outline"; id: number; page: -1 }
	/** the page's markup annotations (highlights, notes, ink, ...) */
	| { t: "annots"; id: number; page: number }
	/** figures, charts and tables on the page, with their captions */
	| { t: "figures"; id: number; page: number }
	/** read these pages' sizes, stopping early after a few ms (the answer lists the ones read) */
	| { t: "sizes"; id: number; page: number; pages: number[] }
	/** stop the running tile job `id` (it answers `cancelled`; a job that already finished answers as usual) */
	| { t: "cancel"; id: number }
	/** a form edit, sent to every worker in the same order; only `report` workers answer */
	| { t: "form"; seq: number; op: FormOp; report: boolean }
	/** the document bytes with their form edits */
	| { t: "save"; id: number };

/** Document metadata (Info dictionary), like pdf.js `getMetadata().info` and lector's `onDocumentLoad`. */
export interface DocumentInfo {
	pageCount: number;
	title?: string;
	author?: string;
	subject?: string;
	keywords?: string;
	creator?: string;
	producer?: string;
	/** raw PDF dates, e.g. "D:20200904120000Z" */
	creationDate?: string;
	modDate?: string;
	/** e.g. 17 for PDF 1.7 */
	pdfVersion?: number;
	encrypted: boolean;
	/** AcroForm fields present (fillable in the viewer) */
	hasForm: boolean;
}

export interface Link {
	/** l, t, r, b in page points (top-left origin) */
	rect: [number, number, number, number];
	url?: string;
	/** internal destination */
	dest?: { page: number; top?: number };
}

export interface OutlineItem {
	title: string;
	dest?: { page: number; top?: number };
	children: OutlineItem[];
}

/** the first raster worker's open path (worker-local durations) */
export interface OpenTiming {
	/** instantiating pdfium.wasm, including the download and compile when no preloaded module was shared */
	wasmMs: number;
	/** a preloaded module was shared with the worker */
	wasmShared: boolean;
	/** PDFium opening the document and reading the page sizes */
	openMs: number;
}

/** The shape of a document PDFium could not open, for diagnosis without its content. */
export interface LoadFailureDetail {
	/** FPDF_GetLastError */
	pdfium: "success" | "unknown" | "file" | "format" | "password" | "security" | "page";
	/** what the first KB looks like: `html` is usually an error page served instead of the PDF */
	header: "pdf" | "html" | "empty" | "other";
	/** a /Linearized dictionary in the first KB */
	linearized: boolean;
	/** an /Encrypt entry in the last KB (the trailer) */
	encrypted: boolean;
	/** no %%EOF in the last KB: likely a cut-off download */
	truncated: boolean;
	sizeKB: number;
}

/** [page, w, h] */
export type SizeEntry = [number, number, number];

export type FromRaster =
	/** sizes: the pages read so far (all of them for `{ all: true }`) */
	| ({ t: "opened"; pageCount: number; sizes: SizeEntry[]; info: DocumentInfo } & Partial<OpenTiming>)
	| { t: "sizes"; id: number; sizes: SizeEntry[]; heap: number }
	| {
			t: "error";
			message: string;
			code: ErrorCode;
			phase: ErrorPhase;
			id?: number;
			detail?: LoadFailureDetail;
			/** `wasm-trap`: the page and PDFium step that trapped, and whether the worker started a fresh PDFium */
			page?: number;
			op?: string;
			recovered?: boolean;
			/** a WebAssembly crash or an allocation failure (`oom`: also PDFium's memory could not be reserved at `engine-load`) */
			trap?: TrapKind;
	  }
	/** heap: the worker's WASM heap plus its block cache, in bytes */
	| { t: "tile"; id: number; buf?: ArrayBuffer; bitmap?: ImageBitmap; baked?: boolean; w: number; h: number; ms: number; heap: number }
	| {
			t: "text";
			id: number;
			page: number;
			/** UTF-32 code points, one per PDFium char (generated spaces/newlines included) */
			codes: Uint32Array;
			/** l, t, r, b per char in page points (top-left origin); zero-area for generated chars */
			boxes: Float32Array;
			links: Link[];
			/** l, t, r, b per raster image in page points (top-left origin) */
			images: Float32Array;
			/** images classified as scan paper (tone-mapped in dark mode, so not in `images`) */
			scans: number;
			/** the page's size, which the core may only have estimated so far */
			size: PageSize;
			/** form field widgets (AcroForm documents) */
			widgets: FormWidget[];
			ms: number;
			heap: number;
	  }
	| { t: "outline"; id: number; items: OutlineItem[] }
	| { t: "annots"; id: number; page: number; items: PdfAnnotation[] }
	| { t: "figures"; id: number; page: number; items: PageFigure[] }
	| { t: "cancelled"; id: number; heap: number }
	/** fields whose value a form edit changed; `reset`: a button that may have changed any field */
	| { t: "form"; seq: number; changed: { name: string; value: string }[]; reset: boolean }
	| { t: "saved"; id: number; buf?: ArrayBuffer; error?: string };
