// Messages between the viewer core and the PDFium raster workers.
// Coordinates sent to workers are in PDF points with a top-left origin.

import type { FormOp, FormWidget } from "./forms";

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
 * not load or crashed; `destroyed`: the viewer was destroyed before a request answered;
 * `unknown`: anything else.
 */
export type ErrorCode = "password" | "parse" | "security" | "file" | "fetch" | "unsupported" | "wasm" | "gpu" | "worker" | "destroyed" | "unknown";
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
	| { t: "init"; source: DocSource; port: MessagePort; wasmUrl: string; module?: WebAssembly.Module; password?: string; sizes?: SizeHint }
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
	  }
	| { t: "text"; id: number; page: number }
	| { t: "outline"; id: number; page: -1 }
	/** read these pages' sizes, stopping early after a few ms (the answer lists the ones read) */
	| { t: "sizes"; id: number; page: number; pages: number[] }
	/** stop the running tile job `id` (it answers `cancelled`; a job that already finished answers as usual) */
	| { t: "cancel"; id: number }
	/** a form edit, sent to every worker in the same order; only `report` workers answer */
	| { t: "form"; seq: number; op: FormOp; report: boolean }
	/** the document bytes with their form edits */
	| { t: "save"; id: number }
	/** sent to every worker in the same order: each applies it to its own copy of the document */
	| { t: "edit"; id: number; page: -1; op: EditOp }
	| { t: "undo"; id: number; page: -1 }
	| { t: "redo"; id: number; page: -1 }
	| { t: "objects"; id: number; page: number };

export type StdFont =
	| "Helvetica"
	| "Helvetica-Bold"
	| "Helvetica-Oblique"
	| "Helvetica-BoldOblique"
	| "Times-Roman"
	| "Times-Bold"
	| "Times-Italic"
	| "Times-BoldItalic"
	| "Courier"
	| "Courier-Bold"
	| "Courier-Oblique"
	| "Courier-BoldOblique";

/** Content edits. `obj`: index in the page's top-level object list when the op runs; points are top-left page points. */
export type EditOp =
	/** absorb: other objects of the same visual line (split runs, per-glyph objects), removed once their text moves into `obj` */
	| { kind: "set-text"; page: number; obj: number; text: string; absorb?: number[] }
	/** x, y: the baseline start */
	| { kind: "add-text"; page: number; x: number; y: number; text: string; size: number; font?: StdFont; color?: [number, number, number] }
	| { kind: "delete-object"; page: number; obj: number }
	| { kind: "move-object"; page: number; obj: number; dx: number; dy: number }
	/** quarter turns clockwise */
	| { kind: "rotate-page"; page: number; quarter: number }
	| { kind: "delete-page"; page: number }
	| { kind: "insert-page"; at: number; w: number; h: number }
	/** removes everything under the rect (text, image pixels, paths) and paints it black */
	| { kind: "redact"; page: number; rect: [number, number, number, number] };

export interface EditOutcome {
	/** pages whose content changed (re-render, re-extract) */
	pages: number[];
	/** pages were added or removed: indices after the touched one moved */
	structure: boolean;
	/** a page changed size or orientation */
	resized?: boolean;
	/** set-text/add-text: "same" when the original font had every glyph, else the standard-14 fallback used */
	font?: "same" | StdFont;
	/** set-text: how much wider (points) the object became; text does not reflow */
	widthDelta?: number;
	/** the area that changed, l t r b in page points (absent: the whole page) */
	region?: [number, number, number, number];
	/** add-text: the new object's index */
	index?: number;
	undone?: boolean;
	/** worker time for the op */
	ms?: number;
}

export interface PageObject {
	index: number;
	type: "unknown" | "text" | "path" | "image" | "shading" | "form";
	/** l, t, r, b in page points (top-left origin) */
	box: [number, number, number, number];
	text?: string;
	font?: string;
	/** font size in page points, text matrix applied */
	size?: number;
	embedded?: boolean;
	/** render mode 3: an OCR layer over a scan */
	invisible?: boolean;
	/** PDF font descriptor flags (1 fixed pitch, 2 serif, 64 italic, 1<<18 force bold) */
	flags?: number;
	/** fill colour, 0-255 RGB */
	color?: [number, number, number];
}

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
	| { t: "error"; message: string; code: ErrorCode; phase: ErrorPhase; id?: number; detail?: LoadFailureDetail }
	/** heap: the worker's WASM heap plus its block cache, in bytes */
	| { t: "tile"; id: number; buf: ArrayBuffer; w: number; h: number; ms: number; heap: number }
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
	| { t: "cancelled"; id: number; heap: number }
	/** fields whose value a form edit changed; `reset`: a button that may have changed any field */
	| { t: "form"; seq: number; changed: { name: string; value: string }[]; reset: boolean }
	| { t: "saved"; id: number; buf?: ArrayBuffer; error?: string }
	/** outcome null: nothing to undo/redo; sizes: every page, after a structural or size change */
	| { t: "edited"; id: number; outcome: EditOutcome | null; error?: string; pageCount: number; sizes: SizeEntry[]; ms: number; heap: number }
	| { t: "objects"; id: number; page: number; objects: PageObject[]; heap: number };
