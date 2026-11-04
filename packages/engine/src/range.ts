// Decisions for HTTP range loading, kept free of I/O so tests run them in Node.

import type { ErrorCode } from "./protocol";

/** Total length from `Content-Range: bytes 0-1023/12345` (null when absent, unexposed by CORS, or `*`). */
export function totalFromContentRange(header: string | null): number | null {
	const total = Number(/\/(\d+)\s*$/.exec(header ?? "")?.[1]);
	return total > 0 ? total : null;
}

/** files up to this size open from one request instead of range reads */
export const WHOLE_FILE_MAX = 8 * 1024 * 1024;

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

/**
 * How much of the probe's body to read before cancelling it: the head block,
 * or for a linearized file opening on page 1, through that page's section.
 */
export function probeReadBytes(lin: { firstPageEnd: number } | null, firstPage: boolean, length: number, block = RANGE_BLOCK): number {
	const head = Math.min(length, block);
	if (!lin || !firstPage) return head;
	return Math.max(head, Math.min(length, WHOLE_FILE_MAX, Math.ceil(lin.firstPageEnd / block) * block));
}

export type BlockVerdict = "ok" | "full" | "error";

/** What a worker's range request for bytes [start, end) of a `fileLen` file returned. */
export function blockVerdict(status: number, received: number, start: number, end: number, fileLen: number): BlockVerdict {
	if (status === 206 && received === end - start) return "ok";
	// The server ignored the range and sent everything.
	if (status === 200 && received === fileLen) return "full";
	return "error";
}

/** A range read worth one more try: a dropped connection, a timeout, a rate limit or a server error. */
export function retryableBlockStatus(status: number): boolean {
	return status === 0 || status === 408 || status === 429 || status >= 500;
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

/** block size for range reads (a worker's cache and the main thread's seeds align to it) */
export const RANGE_BLOCK = 64 * 1024;
/** the most one range read fetches as read-ahead grows */
export const RANGE_MAX_RUN = 1024 * 1024;
