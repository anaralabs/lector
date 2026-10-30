// Byte blocks for PDFium's synchronous GetBlock callback, through a small LRU.
// No runtime imports: tests load this file directly in Node.

export interface BlockFetch {
	/** current block size; may change while `fetch` runs (range fallback) */
	size(): number;
	/** bytes [start, end) */
	fetch(start: number, end: number): Uint8Array;
}

export class BlockCache {
	/** block start offset -> bytes (keyed by offset: the block size can change) */
	private blocks = new Map<number, Uint8Array>();
	bytes = 0;
	readonly length: number;
	private source: BlockFetch;
	private max: number;

	constructor(length: number, source: BlockFetch, max = 24 * 1024 * 1024) {
		this.length = length;
		this.source = source;
		this.max = max;
	}

	clear() {
		this.blocks.clear();
		this.bytes = 0;
	}

	private block(start: number, size: number): Uint8Array {
		const hit = this.blocks.get(start);
		if (hit && hit.length === Math.min(size, this.length - start)) {
			this.blocks.delete(start);
			this.blocks.set(start, hit);
			return hit;
		}
		const data = this.source.fetch(start, Math.min(this.length, start + size));
		// The source switched block size mid-fetch (and dropped the cache):
		// these bytes are right, but not a block of the new size.
		if (this.source.size() !== size) return data;
		this.blocks.set(start, data);
		this.bytes += data.length;
		while (this.bytes > this.max && this.blocks.size > 1) {
			const [k, v] = this.blocks.entries().next().value as [number, Uint8Array];
			this.blocks.delete(k);
			this.bytes -= v.length;
		}
		return data;
	}

	/** Copies bytes [pos, pos + n) into `out` at `at`; false when out of range. */
	read(pos: number, n: number, out: Uint8Array, at: number): boolean {
		if (pos + n > this.length) return false;
		while (n > 0) {
			const size = this.source.size();
			const start = Math.floor(pos / size) * size;
			const data = this.block(start, size);
			const offset = pos - start;
			const k = Math.min(n, data.length - offset);
			if (k <= 0) return false;
			out.set(data.subarray(offset, offset + k), at);
			pos += k;
			at += k;
			n -= k;
		}
		return true;
	}
}
