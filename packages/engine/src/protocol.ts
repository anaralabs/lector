// Messages between the viewer core and the PDFium raster workers.
// Coordinates sent to workers are in PDF points with a top-left origin.

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
export type DocSource = { kind: "blob"; blob: Blob } | { kind: "url"; url: string; length: number; credentials: boolean };

export type ToRaster =
	/** sizes: false for all but one worker (page sizes are read lazily there) */
	| { t: "init"; source: DocSource; port: MessagePort; wasmUrl: string; password?: string; sizes?: boolean }
	/** sent to the worker itself (not the port): the full file arrived, read from it from now on */
	| { t: "source"; blob: Blob }
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
	| { t: "outline"; id: number; page: -1 };

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
	/** AcroForm fields present (rendered read-only) */
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

export type FromRaster =
	| { t: "opened"; pages: PageSize[]; info: DocumentInfo }
	| { t: "error"; message: string; code: ErrorCode; phase: ErrorPhase; id?: number }
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
			ms: number;
			heap: number;
	  }
	| { t: "outline"; id: number; items: OutlineItem[] };
