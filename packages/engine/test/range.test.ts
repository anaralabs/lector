import assert from "node:assert/strict";
import { test } from "node:test";
import { blockVerdict, openErrorCode, probeVerdict, readLinearization, retryableBlockStatus, totalFromContentRange } from "../src/range.ts";

test("Content-Range total, including when CORS hides it", () => {
	assert.equal(totalFromContentRange("bytes 0-1023/52428800"), 52428800);
	assert.equal(totalFromContentRange("bytes 0-1023/*"), null);
	assert.equal(totalFromContentRange(null), null);
});

test("probe: 206 with a readable total ranges; hidden total asks for the length", () => {
	assert.deepEqual(probeVerdict({ status: 206, contentRange: "bytes 0-65535/9000000", contentEncoding: null }), { kind: "range", length: 9000000 });
	assert.deepEqual(probeVerdict({ status: 206, contentRange: null, contentEncoding: null }), { kind: "need-length" });
});

test("probe: servers without range support fall back to the full download", () => {
	// Range ignored: the body is the whole file and is used as is.
	assert.deepEqual(probeVerdict({ status: 200, contentRange: null, contentEncoding: null }), { kind: "full-body" });
	// Compressed ranges point into compressed bytes.
	assert.deepEqual(probeVerdict({ status: 206, contentRange: "bytes 0-1023/5000", contentEncoding: "gzip" }), { kind: "download" });
	assert.deepEqual(probeVerdict({ status: 416, contentRange: null, contentEncoding: null }), { kind: "download" });
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
