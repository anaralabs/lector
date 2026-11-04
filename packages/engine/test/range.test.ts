import assert from "node:assert/strict";
import { test } from "node:test";
import { abandonWhole, blockVerdict, openErrorCode, probeReadBytes, probeVerdict, RANGE_BLOCK, readLinearization, retryableBlockStatus, totalFromContentRange, WHOLE_FILE_MAX, WHOLE_PATIENCE_MS } from "../src/range.ts";

test("Content-Range total, including when CORS hides it", () => {
	assert.equal(totalFromContentRange("bytes 0-1023/52428800"), 52428800);
	assert.equal(totalFromContentRange("bytes 0-1023/*"), null);
	assert.equal(totalFromContentRange(null), null);
});

const MB = 1024 * 1024;

test("probe: 206 with a readable total ranges; hidden total asks for the length", () => {
	assert.deepEqual(probeVerdict({ status: 206, contentRange: `bytes 0-${8 * MB - 1}/9000000`, contentEncoding: null }, 8 * MB), { kind: "range", length: 9000000 });
	assert.deepEqual(probeVerdict({ status: 206, contentRange: null, contentEncoding: null, contentLength: String(8 * MB) }, 8 * MB), { kind: "need-length" });
	assert.deepEqual(probeVerdict({ status: 206, contentRange: null, contentEncoding: null }, 8 * MB), { kind: "need-length" });
});

test("probe: a file that fits in the probed range is the whole response", () => {
	assert.deepEqual(probeVerdict({ status: 206, contentRange: "bytes 0-2097151/2097152", contentEncoding: null }, 8 * MB), { kind: "whole", length: 2 * MB });
	// exactly the probed size: still all there
	assert.deepEqual(probeVerdict({ status: 206, contentRange: `bytes 0-${8 * MB - 1}/${8 * MB}`, contentEncoding: null }, 8 * MB), { kind: "whole", length: 8 * MB });
	// CORS hides Content-Range: a clipped Content-Length says the same
	assert.deepEqual(probeVerdict({ status: 206, contentRange: null, contentEncoding: null, contentLength: "1500000" }, 8 * MB), { kind: "whole", length: 1500000 });
	// encoded bytes are never used as the file
	assert.deepEqual(probeVerdict({ status: 206, contentRange: "bytes 0-999/1000", contentEncoding: "br" }, 8 * MB), { kind: "download" });
});

test("probe read: the head block, or through page 1's section for a linearized file opening there", () => {
	assert.equal(probeReadBytes(null, true, 50 * MB), RANGE_BLOCK);
	assert.equal(probeReadBytes(null, true, 1000), 1000);
	const lin = { firstPageEnd: 300_000 };
	assert.equal(probeReadBytes(lin, true, 50 * MB), Math.ceil(300_000 / RANGE_BLOCK) * RANGE_BLOCK);
	assert.equal(probeReadBytes(lin, false, 50 * MB), RANGE_BLOCK);
	// never past the file or the probed range
	assert.equal(probeReadBytes({ firstPageEnd: 20 * MB }, true, 50 * MB), WHOLE_FILE_MAX);
	assert.equal(probeReadBytes({ firstPageEnd: 9_000_100 }, true, 9_000_200), Math.min(9_000_200, WHOLE_FILE_MAX));
});

test("probe: servers without range support fall back to the full download", () => {
	// Range ignored: the body is the whole file and is used as is.
	assert.deepEqual(probeVerdict({ status: 200, contentRange: null, contentEncoding: null }, 8 * MB), { kind: "full-body" });
	// Compressed ranges point into compressed bytes.
	assert.deepEqual(probeVerdict({ status: 206, contentRange: "bytes 0-1023/50000000", contentEncoding: "gzip" }, 8 * MB), { kind: "download" });
	assert.deepEqual(probeVerdict({ status: 416, contentRange: null, contentEncoding: null }, 8 * MB), { kind: "download" });
});

test("block: a 200 with the whole file switches to it; anything else short fails", () => {
	assert.equal(blockVerdict(206, 65536, 0, 65536, 1e6), "ok");
	assert.equal(blockVerdict(200, 1e6, 0, 65536, 1e6), "full");
	assert.equal(blockVerdict(206, 100, 0, 65536, 1e6), "error");
	assert.equal(blockVerdict(500, 0, 0, 65536, 1e6), "error");
});

test("linearization dictionary", () => {
	const head = new TextEncoder().encode("%PDF-1.7\n%\xe2\xe3\n1 0 obj\n<</Linearized 1/L 52428800/O 4/E 183211/N 312/T 52411234/H [ 512 1200]>>\nendobj\n");
	assert.deepEqual(readLinearization(head, 52428800), { firstPageEnd: 183211, pages: 312 });
	// Updated after linearizing: /L no longer matches, the hints are stale.
	assert.equal(readLinearization(head, 52500000), null);
	assert.equal(readLinearization(new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<</Type/Catalog>>"), 100), null);
});

test("block: dropped connections, timeouts and server errors get another try; client errors do not", () => {
	for (const status of [0, 408, 429, 500, 503]) assert.equal(retryableBlockStatus(status), true, String(status));
	for (const status of [206, 200, 403, 404, 416]) assert.equal(retryableBlockStatus(status), false, String(status));
});

test("open: a block that could not be read is a fetch failure, not a broken file", () => {
	assert.equal(openErrorCode(3, false), "parse");
	assert.equal(openErrorCode(3, true), "fetch");
	assert.equal(openErrorCode(2, true), "fetch");
	assert.equal(openErrorCode(4, true), "password");
	assert.equal(openErrorCode(5, false), "security");
	assert.equal(openErrorCode(9, false), "unknown");
});

test("whole download: kept while it is quick, abandoned for ranges once it is clearly slower", () => {
	const len = 6.5 * MB;
	// not before the patience runs out, however slow
	assert.equal(abandonWhole({ elapsedMs: WHOLE_PATIENCE_MS - 1, received: 1000, length: len, rttMs: 50 }), false);
	// 10 Mbit/s, 50ms: 4.6MB left take ~3.7s, ranges ~1.4s
	assert.equal(abandonWhole({ elapsedMs: 1500, received: 1.875 * MB, length: len, rttMs: 50 }), true);
	// 50 Mbit/s, 150ms: nearly done
	assert.equal(abandonWhole({ elapsedMs: 1500, received: 6 * MB, length: len, rttMs: 150 }), false);
	// a 2MB file at 10 Mbit/s is almost there by then
	assert.equal(abandonWhole({ elapsedMs: 1500, received: 1.875 * MB, length: 2.1 * MB, rttMs: 50 }), false);
	// very slow links: ranges cost bytes too, so a small file stays whole
	assert.equal(abandonWhole({ elapsedMs: 1500, received: 60_000, length: 1.5 * MB, rttMs: 300 }), false);
	assert.equal(abandonWhole({ elapsedMs: 1500, received: len, length: len, rttMs: 50 }), false);
});
