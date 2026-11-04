import assert from "node:assert/strict";
import { test } from "node:test";
import { documentKey, TileCache, tileCacheSupported } from "../src/tile-cache.ts";

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

test("document keys follow the content: same bytes match, an appended save or a different length does not", async () => {
	const a = bytes(600 * 1024, 1);
	const k1 = await documentKey(new Blob([a]));
	const k2 = await documentKey(new Blob([a.slice()]));
	assert.match(k1!, /^sha256:[0-9a-f]{64}$/);
	assert.equal(k1, k2);
	const tail = a.slice();
	tail[tail.length - 10] ^= 0xff;
	assert.notEqual(await documentKey(new Blob([tail])), k1);
	assert.notEqual(await documentKey(new Blob([a, bytes(10, 2)])), k1);
});

test("without IndexedDB the cache stays off and never answers", async () => {
	assert.equal(tileCacheSupported(), false);
	const cache = new TileCache("doc", 1024 * 1024);
	await cache.ready;
	assert.equal(cache.enabled, false);
	assert.equal(cache.has(0, 1, 1, 1), false);
	assert.equal(await cache.get(0, 1, 1, 1), null);
	cache.put(0, 1, new Uint8Array(4), 1, 1);
});
