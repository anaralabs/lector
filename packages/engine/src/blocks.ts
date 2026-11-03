// Byte blocks for PDFium's synchronous GetBlock callback, through a small LRU.
// Missing blocks next to each other are fetched in one request, and reads that
// keep going forward fetch further ahead each time (a parser walking a stream).
// No runtime imports: tests load this file directly in Node.

export interface BlockFetch {
	/** current block size; may change while `fetch` runs (range fallback) */
	size(): number;
	/** bytes [start, end) */
	fetch(start: number, end: number): Uint8Array;
}

export interface BlockCacheOptions {
	/** cache cap in bytes */
	max?: number;
	/** largest single request, in blocks (read-ahead grows up to it) */
	maxRun?: number;
	/** called with every block fetched (not seeded), e.g. to share it */
	onFetched?: (start: number, data: Uint8Array) => void;
}

export class BlockCache {
	/** block start offset -> bytes (keyed by offset: the block size can change) */
	private blocks = new Map<number, Uint8Array>();
	bytes = 0;
	/** bytes fetched from the source (not seeded) */
	fetched = 0;
	requests = 0;
	readonly length: number;
	private source: BlockFetch;
	private max: number;
	private maxRun: number;
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

	/** Adds bytes [start, start + data.length) that arrived another way: whole aligned blocks only. */
	seed(start: number, data: Uint8Array) {
		const size = this.source.size();
		const end = start + data.length;
		for (let s = Math.ceil(start / size) * size; s < end; s += size) {
			const e = Math.min(this.length, s + size);
			if (e > end || this.blocks.has(s)) continue;
			this.put(s, data.subarray(s - start, e - start));
		}
		this.trim();
	}

	private put(start: number, data: Uint8Array) {
		const old = this.blocks.get(start);
		if (old) this.bytes -= old.length;
		this.blocks.delete(start);
		this.blocks.set(start, data);
		this.bytes += data.length;
	}

	private trim() {
		while (this.bytes > this.max && this.blocks.size > 1) {
			const [k, v] = this.blocks.entries().next().value as [number, Uint8Array];
			this.blocks.delete(k);
			this.bytes -= v.length;
		}
	}

	private hit(start: number, size: number): Uint8Array | null {
		const hit = this.blocks.get(start);
		if (!hit || hit.length !== Math.min(size, this.length - start)) return null;
		this.blocks.delete(start);
		this.blocks.set(start, hit);
		return hit;
	}

	/** Copies bytes [pos, pos + n) into `out` at `at`; false when out of range. */
	read(pos: number, n: number, out: Uint8Array, at: number): boolean {
		if (pos < 0 || pos + n > this.length) return false;
		while (n > 0) {
			const size = this.source.size();
			const start = Math.floor(pos / size) * size;
			const hit = this.hit(start, size);
			if (hit) {
				const k = Math.min(n, hit.length - (pos - start));
				if (k <= 0) return false;
				out.set(hit.subarray(pos - start, pos - start + k), at);
				pos += k;
				at += k;
				n -= k;
				continue;
			}
			// One request for every missing block this read needs, plus read-ahead.
			const lastNeeded = Math.floor((pos + n - 1) / size) * size;
			this.ahead = start === this.nextSequential ? Math.min(this.maxRun, Math.max(2, this.ahead * 2)) : 1;
			const limit = Math.min(this.length, Math.max(lastNeeded + size, start + this.ahead * size));
			let end = start + size;
			while (end < limit && !this.blocks.has(end)) end += size;
			end = Math.min(end, this.length);
			const data = this.source.fetch(start, end);
			this.requests++;
			this.fetched += data.length;
			this.nextSequential = end;
			if (data.length !== end - start) return false;
			// The source switched block size mid-fetch (and dropped the cache):
			// these bytes are right, but not blocks of the new size.
			if (this.source.size() === size) {
				for (let s = start; s < end; s += size) {
					const block = data.subarray(s - start, Math.min(end, s + size) - start);
					this.put(s, block);
					this.onFetched?.(s, block);
				}
				this.trim();
			}
			const k = Math.min(n, end - pos);
			out.set(data.subarray(pos - start, pos - start + k), at);
			pos += k;
			at += k;
			n -= k;
		}
		return true;
	}
}
