type CacheEntry = {
	bitmap: ImageBitmap;
	width: number;
	height: number;
};

/**
 * LRU cache for rendered page bitmaps. When scrolling back to a previously
 * rendered page at the same scale, we can draw from cache instantly instead
 * of re-rendering through PDF.js.
 */
class RenderCache {
	private cache = new Map<string, CacheEntry>();
	private maxEntries: number;

	constructor(maxEntries = 30) {
		this.maxEntries = maxEntries;
	}

	private key(pageNumber: number, scale: number, background?: string): string {
		return `${pageNumber}-${scale}-${background ?? "white"}`;
	}

	get(pageNumber: number, scale: number, background?: string): CacheEntry | undefined {
		const k = this.key(pageNumber, scale, background);
		const entry = this.cache.get(k);
		if (!entry) return undefined;

		// Move to end (most recently used)
		this.cache.delete(k);
		this.cache.set(k, entry);
		return entry;
	}

	async set(
		pageNumber: number,
		scale: number,
		canvas: HTMLCanvasElement,
		background?: string,
	): Promise<void> {
		const k = this.key(pageNumber, scale, background);

		// Evict oldest entries if at capacity
		while (this.cache.size >= this.maxEntries) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				const entry = this.cache.get(oldest);
				entry?.bitmap.close();
				this.cache.delete(oldest);
			}
		}

		try {
			const bitmap = await createImageBitmap(canvas);
			this.cache.set(k, {
				bitmap,
				width: canvas.width,
				height: canvas.height,
			});
		} catch {
			// createImageBitmap can fail on empty canvases or unsupported environments
		}
	}

	invalidatePage(pageNumber: number): void {
		for (const [k, entry] of this.cache) {
			if (k.startsWith(`${pageNumber}-`)) {
				entry.bitmap.close();
				this.cache.delete(k);
			}
		}
	}

	clear(): void {
		for (const entry of this.cache.values()) {
			entry.bitmap.close();
		}
		this.cache.clear();
	}
}

export const renderCache = new RenderCache();
