// Decisions for HTTP range loading, kept free of I/O so tests run them in Node.

/** Total length from `Content-Range: bytes 0-1023/12345` (null when absent, unexposed by CORS, or `*`). */
export function totalFromContentRange(header: string | null): number | null {
	const total = Number(/\/(\d+)\s*$/.exec(header ?? "")?.[1]);
	return total > 0 ? total : null;
}

export type ProbeVerdict =
	/** ranges work: read blocks on demand */
	| { kind: "range"; length: number }
	/** ranges work but the total is hidden (CORS without `Content-Range` exposed): ask with HEAD */
	| { kind: "need-length" }
	/** the server sent the whole file: use this response's body */
	| { kind: "full-body" }
	/** ranges do not work as needed (encoded bytes): download the file */
	| { kind: "download" };

/**
 * What a `Range: bytes=0-N` probe says. Encoded (compressed) responses cannot be
 * range-read: offsets would point into compressed bytes. `Content-Encoding` is
 * not visible cross-origin unless exposed, so a body longer than asked for also
 * counts as "not ranged".
 */
export function probeVerdict(res: { status: number; contentRange: string | null; contentEncoding: string | null }): ProbeVerdict {
	if (res.status === 200) return { kind: "full-body" };
	if (res.status !== 206) return { kind: "download" };
	if ((res.contentEncoding ?? "identity") !== "identity") return { kind: "download" };
	const total = totalFromContentRange(res.contentRange);
	return total ? { kind: "range", length: total } : { kind: "need-length" };
}

export type BlockVerdict = "ok" | "full" | "error";

/** What a worker's range request for bytes [start, end) of a `fileLen` file returned. */
export function blockVerdict(status: number, received: number, start: number, end: number, fileLen: number): BlockVerdict {
	if (status === 206 && received === end - start) return "ok";
	// The server ignored the range and sent everything.
	if (status === 200 && received === fileLen) return "full";
	return "error";
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
export const RANGE_BLOCK = 16 * 1024;
