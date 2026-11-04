// node --test test/  (Node 23.6+ strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockCache } from "../src/blocks.ts";

const K = 64 * 1024;
const file = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
const read = (cache: BlockCache, pos: number, n: number) => {
	const out = new Uint8Array(n);
	assert.ok(cache.read(pos, n, out, 0));
	return out;
};
/** A range source that records each request as [start, end). */
const ranged = (size = K) => {
	const calls: [number, number][] = [];
	const cache = new BlockCache(file.length, {
		size: () => size,
		fetch: (start, end) => {
			calls.push([start, end]);
			return file.slice(start, end);
		},
	});
	return { cache, calls };
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

test("a read across missing blocks is one request; a cached block splits it, a few cached granules do not", () => {
	const G = 16 * 1024;
	const { cache, calls } = ranged();
	assert.deepEqual(read(cache, K - 10, 20), file.subarray(K - 10, K + 10));
	assert.deepEqual(calls, [[0, 2 * K]]);
	calls.length = 0;
	// Blocks 2..5 needed, block 3 already cached from a seed: two requests around it.
	cache.seed(3 * K, file.slice(3 * K, 4 * K));
	assert.deepEqual(read(cache, 2 * K + 5, 3 * K), file.subarray(2 * K + 5, 5 * K + 5));
	assert.deepEqual(calls, [
		[2 * K, 3 * K],
		[4 * K, 6 * K],
	]);
	calls.length = 0;
	// one cached granule in the middle is fetched again rather than costing a second round trip
	cache.seed(8 * K + G, file.slice(8 * K + G, 8 * K + 2 * G));
	assert.deepEqual(read(cache, 8 * K, 2 * K), file.subarray(8 * K, 10 * K));
	assert.deepEqual(calls, [[8 * K, 10 * K]]);
});

test("sequential misses read further ahead each time, up to maxRun", () => {
	const { cache, calls } = ranged();
	for (let pos = 0; pos < 12 * K; pos += K) read(cache, pos, 100);
	// 1 block, then 2, 4, 8 as the reads keep going forward.
	assert.deepEqual(
		calls.map(([s, e]) => [s / K, (e - s) / K]),
		[
			[0, 1],
			[1, 2],
			[3, 4],
			[7, 8],
		],
	);
	// A jump elsewhere starts small again.
	calls.length = 0;
	read(cache, 15 * K + 10, 10);
	assert.deepEqual(calls, [[15 * K, 16 * K]]);
});

test("seeded bytes are used without a request; partial blocks are not seeded", () => {
	const { cache, calls } = ranged();
	cache.seed(0, file.slice(0, K + 100));
	const tailStart = file.length - 3 * K;
	cache.seed(tailStart, file.slice(tailStart));
	assert.deepEqual(read(cache, 10, 100), file.subarray(10, 110));
	assert.deepEqual(read(cache, file.length - 50, 50), file.subarray(file.length - 50));
	assert.equal(calls.length, 0);
	read(cache, K + 10, 10);
	assert.deepEqual(calls, [[K, 2 * K]]);
});

test("the last block is short; reads past the end fail", () => {
	const len = 3 * K + 123;
	const calls: [number, number][] = [];
	const cache = new BlockCache(len, {
		size: () => K,
		fetch: (s, e) => {
			calls.push([s, e]);
			return file.slice(s, e);
		},
	});
	assert.deepEqual(read(cache, len - 23, 23), file.subarray(len - 23, len));
	assert.deepEqual(calls, [[3 * K, len]]);
	assert.ok(!cache.read(len - 1, 2, new Uint8Array(2), 0));
});

test("evicts least recently used past the cap", () => {
	let fetches = 0;
	const cache = new BlockCache(
		file.length,
		{
			size: () => K,
			fetch: (start, end) => {
				fetches++;
				return file.slice(start, end);
			},
		},
		{ max: 2 * K },
	);
	read(cache, 0, 1);
	read(cache, 5 * K, 1);
	read(cache, 0, 1);
	assert.equal(fetches, 2);
	read(cache, 9 * K, 1);
	assert.equal(cache.bytes, 2 * K);
	// block 5 was least recently used
	read(cache, 0, 1);
	assert.equal(fetches, 3);
	read(cache, 5 * K, 1);
	assert.equal(fetches, 4);
});

test("fetched blocks are reported for sharing, seeded ones are not", () => {
	const shared: number[] = [];
	const cache = new BlockCache(file.length, { size: () => K, fetch: (s, e) => file.slice(s, e) }, { onFetched: (s) => shared.push(s) });
	cache.seed(0, file.slice(0, K));
	read(cache, 0, 2 * K);
	assert.deepEqual(shared, [K]);
});

test("each request is reported once with all its bytes, so the host can count requests", () => {
	const runs: [number, number][] = [];
	const cache = new BlockCache(file.length, { size: () => K, fetch: (s, e) => file.slice(s, e) }, { onFetched: (s, d) => runs.push([s, s + d.length]) });
	read(cache, 0, 3 * K);
	read(cache, 8 * K, 1);
	assert.deepEqual(runs, [
		[0, 3 * K],
		[8 * K, 9 * K],
	]);
	assert.equal(cache.requests, 2);
});

test("seeds finer than a block: a scattered object costs no request, a miss next to it starts after it", () => {
	const G = 16 * 1024;
	const calls: [number, number][] = [];
	const fetch = (s: number, e: number) => {
		calls.push([s, e]);
		return file.slice(s, e);
	};
	const cache = new BlockCache(file.length, { size: () => 4 * K, fetch }, { granule: G });
	cache.seed(5 * G, file.slice(5 * G, 6 * G));
	assert.deepEqual(read(cache, 5 * G + 7, 100), file.subarray(5 * G + 7, 5 * G + 107));
	assert.equal(calls.length, 0);
	// a read over it is still one request
	assert.deepEqual(read(cache, 0, 8 * G), file.subarray(0, 8 * G));
	assert.deepEqual(calls, [[0, 4 * K]]);
});

test("read-ahead stops at maxRun blocks", () => {
	const calls: [number, number][] = [];
	const fetch = (s: number, e: number) => {
		calls.push([s, e]);
		return file.slice(s, e);
	};
	const cache = new BlockCache(file.length, { size: () => K, fetch }, { maxRun: 2 });
	for (let pos = 0; pos < 8 * K; pos += K) read(cache, pos, K);
	assert.ok(calls.every(([s, e]) => e - s <= 2 * K));
});

test("cached granules at the block start are skipped; the request starts at the first missing one", () => {
	const G = 16 * 1024;
	const calls: [number, number][] = [];
	const fetch = (s: number, e: number) => {
		calls.push([s, e]);
		return file.slice(s, e);
	};
	const cache = new BlockCache(file.length, { size: () => 4 * K, fetch }, { granule: G });
	cache.seed(0, file.slice(0, 3 * G));
	cache.seed(5 * G, file.slice(5 * G, 6 * G));
	assert.deepEqual(read(cache, 7 * G + 3, 10), file.subarray(7 * G + 3, 7 * G + 13));
	assert.deepEqual(calls, [[3 * G, 4 * K]]);
});

test("random reads over random seeds always return the file's bytes", () => {
	let seed = 7;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const G = 16 * 1024;
	for (let trial = 0; trial < 20; trial++) {
		const cache = new BlockCache(file.length, { size: () => 4 * K, fetch: (s, e) => file.slice(s, e) }, { granule: G, maxRun: 4, max: Math.floor(rand() * 600_000) + G });
		for (let i = 0; i < 12; i++) {
			const s = Math.floor((rand() * file.length) / G) * G;
			cache.seed(s, file.slice(s, Math.min(file.length, s + G * (1 + Math.floor(rand() * 3)))));
		}
		for (let i = 0; i < 300; i++) {
			const pos = Math.floor(rand() * file.length);
			const n = Math.max(1, Math.min(file.length - pos, Math.floor(rand() * (rand() < 0.1 ? 300_000 : 5000))));
			assert.deepEqual(read(cache, pos, n), file.subarray(pos, pos + n));
		}
	}
});
