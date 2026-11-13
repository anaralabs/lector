// Decisions for HTTP range loading, kept free of I/O so tests run them in Node.

import type { ErrorCode } from "./protocol";

/** Total length from `Content-Range: bytes 0-1023/12345` (null when absent, unexposed by CORS, or `*`). */
export function totalFromContentRange(header: string | null): number | null {
	const total = Number(/\/(\d+)\s*$/.exec(header ?? "")?.[1]);
	return total > 0 ? total : null;
}

/** files up to this size open from one request instead of range reads */
export const WHOLE_FILE_MAX = 8 * 1024 * 1024;
/** files up to this size keep downloading whole while range reads open them: whichever has the first page first wins */
export const RACE_FILE_MAX = 32 * 1024 * 1024;

export type ProbeVerdict =
	/** the 206 body is the entire file (it fits in the probed range): read it to the end */
	| { kind: "whole"; length: number }
	/** ranges work: read blocks on demand */
	| { kind: "range"; length: number }
	/** ranges work but the total is hidden (CORS without `Content-Range` exposed): ask with HEAD */
	| { kind: "need-length" }
	/** the server sent the whole file: use this response's body */
	| { kind: "full-body" }
	/** ranges do not work as needed (encoded bytes): download the file */
	| { kind: "download" };

/**
 * What a `Range: bytes=0-(asked - 1)` probe says. Encoded (compressed)
 * responses cannot be range-read: offsets would point into compressed bytes.
 * `Content-Encoding` is not visible cross-origin unless exposed, so a body
 * longer than asked for also counts as "not ranged". `Content-Length` is always
 * readable: shorter than asked means the range was clipped to the whole file.
 */
export function probeVerdict(
	res: { status: number; contentRange: string | null; contentEncoding: string | null; contentLength?: string | null },
	asked: number,
): ProbeVerdict {
	if (res.status === 200) return { kind: "full-body" };
	if (res.status !== 206) return { kind: "download" };
	if ((res.contentEncoding ?? "identity") !== "identity") return { kind: "download" };
	const total = totalFromContentRange(res.contentRange);
	if (total) return total <= asked ? { kind: "whole", length: total } : { kind: "range", length: total };
	const sent = Number(res.contentLength ?? 0);
	if (sent > 0 && sent < asked) return { kind: "whole", length: sent };
	return { kind: "need-length" };
}

/** How much of the probe's body to read before cancelling it: the head block, or through page 1's section for a linearized file opening there. */
export function probeReadBytes(lin: { firstPageEnd: number } | null, firstPage: boolean, length: number): number {
	const head = Math.min(length, HEAD_BYTES);
	if (!lin || !firstPage) return head;
	return Math.max(head, Math.min(length, WHOLE_FILE_MAX, Math.ceil(lin.firstPageEnd / RANGE_GRANULE) * RANGE_GRANULE));
}

export type BlockVerdict = "ok" | "full" | "error";

/** What a worker's range request for bytes [start, end) of a `fileLen` file returned. */
export function blockVerdict(status: number, received: number, start: number, end: number, fileLen: number): BlockVerdict {
	if (status === 206 && received === end - start) return "ok";
	// The server ignored the range and sent everything.
	if (status === 200 && received === fileLen) return "full";
	return "error";
}

/** FPDF_GetLastError -> ErrorCode */
const LOAD_ERRORS: Record<number, ErrorCode> = { 2: "file", 3: "parse", 4: "password", 5: "security" };

/**
 * Why `FPDF_LoadCustomDocument` failed. PDFium reports a block it could not
 * read as a format error, so a failed read during the open means the bytes
 * never arrived, not that the file is broken.
 */
export function openErrorCode(pdfiumError: number, readFailed: boolean): ErrorCode {
	const code = LOAD_ERRORS[pdfiumError] ?? "unknown";
	return readFailed && code !== "password" ? "fetch" : code;
}

/** PDFium looks for `%PDF-` only in a file's first KB; pdf.js opens files with more in front of it. */
export const PDFIUM_HEADER_WINDOW = 1024;
/** how far into a file the engine looks for a header PDFium missed */
export const HEADER_SCAN_BYTES = 1024 * 1024;

/** Offset of the first `%PDF-` in `bytes`, or -1. */
export function headerOffset(bytes: Uint8Array): number {
	for (let i = bytes.indexOf(0x25); i >= 0 && i + 5 <= bytes.length; i = bytes.indexOf(0x25, i + 1)) {
		if (bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return i;
	}
	return -1;
}

/**
 * Whether a failed open is worth one more try from the whole file, fetched in
 * one response: range reads can stitch together two versions of a file
 * rewritten in place (or meet one whose length changed), which PDFium reports
 * as a format error or a failed read. A trapped PDFium gets a fresh instance
 * whatever the source. A password or an unsupported security handler stays.
 */
export function reopenWorthIt(code: ErrorCode | "trap", rangeRead: boolean): boolean {
	if (code === "trap") return true;
	return rangeRead && (code === "parse" || code === "fetch" || code === "unknown");
}

/**
 * The linearization dictionary in a file's first bytes (`/Linearized 1 /L len
 * /E endOfFirstPage /O firstPageObj /N pages ...`), or null for a file that is
 * not linearized or whose /L disagrees with its real length (updated since).
 */
export function readLinearization(head: Uint8Array, fileLen: number): { firstPageEnd: number; pages: number } | null {
	const text = new TextDecoder("latin1").decode(head.subarray(0, Math.min(head.length, 2048)));
	const dict = /<<[^>]*\/Linearized\s+[\d.]+[^>]*>>/.exec(text)?.[0];
	if (!dict) return null;
	const num = (key: string) => Number(new RegExp(`/${key}\\s+(\\d+)`).exec(dict)?.[1]);
	const L = num("L");
	const E = num("E");
	const N = num("N");
	if (L !== fileLen || !(E > 0) || E > fileLen || !(N > 0)) return null;
	return { firstPageEnd: E, pages: N };
}

/** a whole-file download that would take this many times longer than range reads stops early (300ms on) */
const EARLY_ABANDON_RATIO = 3;
/** a whole-file download is reconsidered once it has run this long */
export const WHOLE_PATIENCE_MS = 1500;
/** what opening from range reads costs before the first paint, roughly (benchmarks with 256KB reads: 3-15 requests, 0.3-2.5MB) */
const RANGE_OPEN_TRIPS = 8;
const RANGE_OPEN_BYTES = 1024 * 1024;

/** The rest of a whole-file download at its rate so far would take clearly longer than range reads need (slow start makes the rate err low, towards ranges). */
export function abandonWhole(s: { elapsedMs: number; received: number; length: number; rttMs: number }): boolean {
	if (s.elapsedMs < RANGES_BESIDE_AFTER_MS || s.received <= 0 || s.received >= s.length) return false;
	const perMs = s.received / s.elapsedMs;
	const ratio = (s.length - s.received) / perMs / (RANGE_OPEN_TRIPS * s.rttMs + RANGE_OPEN_BYTES / perMs);
	// before WHOLE_PATIENCE_MS only a download several times too slow stops
	return ratio > (s.elapsedMs < WHOLE_PATIENCE_MS ? EARLY_ABANDON_RATIO : 1.25);
}

/** a small file's download is judged this long before range reads may start beside it */
export const RANGES_BESIDE_AFTER_MS = 300;
/** what range reads need before the first paint while a download shares the link, roughly */
const BESIDE_TRIPS = 4;
const BESIDE_BYTES = 512 * 1024;

/** The rest of a small file's download looks slower than opening from range reads: start them beside it (it keeps going). */
export function rangesBeside(s: { elapsedMs: number; received: number; length: number; rttMs: number }): boolean {
	if (s.elapsedMs < RANGES_BESIDE_AFTER_MS || s.received <= 0 || s.received >= s.length) return false;
	const perMs = s.received / s.elapsedMs;
	return (s.length - s.received) / perMs > BESIDE_TRIPS * s.rttMs + BESIDE_BYTES / perMs;
}

/** the least a worker's range read fetches (fewer round trips; costs some bytes on slow links) */
export const RANGE_BLOCK = 256 * 1024;
/** unit of a worker's block cache and of the main thread's seeds, so scattered objects cost little */
export const RANGE_GRANULE = 16 * 1024;
/** the file's first bytes read from the probe: header and linearization dictionary */
export const HEAD_BYTES = 64 * 1024;
/** the most one range read fetches as read-ahead grows */
export const RANGE_MAX_RUN = 1024 * 1024;
