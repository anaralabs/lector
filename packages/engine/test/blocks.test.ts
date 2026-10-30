// node --test test/  (Node 23.6+ strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockCache } from "../src/blocks.ts";

const file = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
const read = (cache: BlockCache, pos: number, n: number) => {
	const out = new Uint8Array(n);
	assert.ok(cache.read(pos, n, out, 0));
	return out;
};

test("range fallback: blocks after the size change come from the right offsets", () => {
	// Range blocks (256K) until the first fetch, which gets HTTP 200 and switches to 64K blocks.
	let size = 256 * 1024;
	let ranged = true;
	const cache = new BlockCache(file.length, {
		size: () => size,
		fetch: (start, end) => {
			if (ranged) {
				ranged = false;
				size = 64 * 1024;
				cache.clear();
			}
			return file.slice(start, end);
		},
	});
	assert.deepEqual(read(cache, 262144, 100), file.subarray(262144, 262244));
	// Block index 1 at 64K is offset 65536, not the 256K block cached before the switch.
	assert.deepEqual(read(cache, 65536, 100), file.subarray(65536, 65636));
	assert.deepEqual(read(cache, 262144 + 50, 100), file.subarray(262194, 262294));
});

test("reads across blocks and evicts least recently used", () => {
	let fetches = 0;
	const cache = new BlockCache(
		file.length,
		{
			size: () => 64 * 1024,
			fetch: (start, end) => {
				fetches++;
				return file.slice(start, end);
			},
		},
		128 * 1024,
	);
	assert.deepEqual(read(cache, 65536 - 10, 20), file.subarray(65526, 65546));
	assert.equal(fetches, 2);
	read(cache, 0, 1);
	assert.equal(fetches, 2);
	read(cache, 200000, 1);
	assert.equal(cache.bytes, 128 * 1024);
	assert.ok(!cache.read(file.length - 1, 2, new Uint8Array(2), 0));
});
