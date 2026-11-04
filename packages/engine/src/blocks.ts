// Byte blocks for PDFium's synchronous GetBlock callback, through a small LRU.
// Missing blocks next to each other are fetched in one request, and reads that
// keep going forward fetch further ahead each time (a parser walking a stream).
// Bytes are kept in small granules, so seeds can be finer than a request.
// No runtime imports: tests load this file directly in Node.

export interface BlockFetch {
	/** the least one request fetches, aligned to it; may change while `fetch` runs (range fallback) */
	size(): number;
	/** bytes [start, end) */
	fetch(start: number, end: number): Uint8Array;
}

export interface BlockCacheOptions {
	/** cache cap in bytes */
	max?: number;
	/** largest single request, in blocks (read-ahead grows up to it) */
	maxRun?: number;
	/** unit the cache stores and accepts seeds in; divides every block size */
	granule?: number;
	/** called with the bytes of every request (not seeds), e.g. to share them */
	onFetched?: (start: number, data: Uint8Array) => void;
}

export class BlockCache {
	/** granule start offset -> bytes, in LRU order */
	private blocks = new Map<number, Uint8Array>();
	bytes = 0;
	/** bytes fetched from the source (not seeded) */
	fetched = 0;
	requests = 0;
	readonly length: number;
	private source: BlockFetch;
	private max: number;
	private maxRun: number;
	private granule: number;
	private onFetched?: (start: number, data: Uint8Array) => void;
	/** where the last fetch ended, and how many blocks the next miss there reads */
	private nextSequential = -1;
	private ahead = 0;

	constructor(length: number, source: BlockFetch, options: BlockCacheOptions | number = {}) {
		const o = typeof options === "number" ? { max: options } : options;
		this.length = length;
		this.source = source;
		this.max = o.max ?? 24 * 1024 * 1024;
		this.maxRun = o.maxRun ?? 64;
		this.granule = o.granule ?? 16 * 1024;
		this.onFetched = o.onFetched;
	}

	clear() {
		this.blocks.clear();
		this.bytes = 0;
		this.nextSequential = -1;
		this.ahead = 0;
	}

	has(start: number) {
		return this.blocks.has(start);
	}

	/** Adds bytes [start, start + data.length) that arrived another way: whole aligned granules only. */
	seed(start: number, data: Uint8Array) {
		this.store(start, data);
		this.trim();
	}

	private store(start: number, data: Uint8Array) {
		const g = this.granule;
		const end = start + data.length;
		for (let s = Math.ceil(start / g) * g; s < end; s += g) {
			const e = Math.min(this.length, s + g);
			if (e > end || this.blocks.has(s)) continue;
			this.blocks.set(s, data.subarray(s - start, e - start));
			this.bytes += e - s;
		}
	}

	private trim() {
		while (this.bytes > this.max && this.blocks.size > 1) {
			const [k, v] = this.blocks.entries().next().value as [number, Uint8Array];
			this.blocks.delete(k);
			this.bytes -= v.length;
		}
	}

	private hit(start: number): Uint8Array | null {
		const hit = this.blocks.get(start);
		if (!hit || hit.length !== Math.min(this.granule, this.length - start)) return null;
		this.blocks.delete(start);
		this.blocks.set(start, hit);
		return hit;
	}

	/** Copies bytes [pos, pos + n) into `out` at `at`; false when out of range. */
	read(pos: number, n: number, out: Uint8Array, at: number): boolean {
		if (pos < 0 || pos + n > this.length) return false;
		const g = this.granule;
		while (n > 0) {
			const granule = Math.floor(pos / g) * g;
			const hit = this.hit(granule);
			if (hit) {
				const k = Math.min(n, hit.length - (pos - granule));
				if (k <= 0) return false;
				out.set(hit.subarray(pos - granule, pos - granule + k), at);
				pos += k;
				at += k;
				n -= k;
				continue;
			}
			// One request through what this read needs (a few cached granules in the way cost less than a round trip), plus read-ahead.
			const size = this.source.size();
			const blockStart = Math.floor(pos / size) * size;
			let start = blockStart;
			while (start < granule && this.blocks.has(start)) start += g;
			this.ahead = start === this.nextSequential ? Math.min(this.maxRun, Math.max(2, this.ahead * 2)) : 1;
			const needed = Math.min(this.length, Math.ceil((pos + n) / g) * g);
			const limit = Math.min(this.length, Math.max(Math.ceil((pos + n) / size) * size, blockStart + this.ahead * size));
			let end = start + g;
			while (end < limit) {
				if (!this.blocks.has(end)) {
					end += g;
					continue;
				}
				if (end >= needed) break;
				let cached = end;
				while (cached < needed && this.blocks.has(cached) && cached - end < size) cached += g;
				if (cached - end >= size) break;
				end = cached;
			}
			end = Math.min(end, this.length);
			const data = this.source.fetch(start, end);
			this.requests++;
			this.fetched += data.length;
			this.nextSequential = end;
			if (data.length !== end - start) return false;
			this.store(start, data);
			this.onFetched?.(start, data);
			this.trim();
			const k = Math.min(n, end - pos);
			out.set(data.subarray(pos - start, pos - start + k), at);
			pos += k;
			at += k;
			n -= k;
		}
		return true;
	}
}
