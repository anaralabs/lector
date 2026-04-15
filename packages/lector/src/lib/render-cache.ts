type CacheEntry = {
	bitmap: ImageBitmap;
	width: number;
	height: number;
};

/**
 * LRU cache for rendered page bitmaps. When scrolling back to a previously
 * rendered page at the same scale, we can draw from cache instantly instead
 * of re-rendering through PDF.js.
 *
 * Cache keys include a document ID to prevent collisions when multiple
 * <Root> instances render different PDFs on the same page.
 */
class RenderCache {
	private cache = new Map<string, CacheEntry>();
	private maxEntries: number;
	// Tracks invalidated documents so in-flight createImageBitmap calls
	// don't insert orphaned entries after invalidateDocument() runs.
	private invalidatedDocs = new Set<string>();

	constructor(maxEntries = 60) {
		this.maxEntries = maxEntries;
	}

	private key(
		documentId: string,
		pageNumber: number,
		scale: number,
		background?: string,
	): string {
		return `${documentId}-${pageNumber}-${scale}-${background ?? "white"}`;
	}

	get(
		documentId: string,
		pageNumber: number,
		scale: number,
		background?: string,
	): CacheEntry | undefined {
		const k = this.key(documentId, pageNumber, scale, background);
		const entry = this.cache.get(k);
		if (!entry) return undefined;

		// Move to end (most recently used)
		this.cache.delete(k);
		this.cache.set(k, entry);
		return entry;
	}

	async set(
		documentId: string,
		pageNumber: number,
		scale: number,
		canvas: HTMLCanvasElement,
		background?: string,
	): Promise<void> {
		const k = this.key(documentId, pageNumber, scale, background);

		// Capture dimensions before any async work — the caller may zero the
		// buffer canvas for Safari memory release before createImageBitmap resolves.
		const w = canvas.width;
		const h = canvas.height;

		if (w === 0 || h === 0) return;

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

			// Check if the document was invalidated while createImageBitmap was in-flight
			if (this.invalidatedDocs.has(documentId)) {
				bitmap.close();
				return;
			}

			this.cache.set(k, {
				bitmap,
				width: w,
				height: h,
			});
		} catch {
			// createImageBitmap can fail on empty canvases or unsupported environments
		}
	}

	/** Remove all cached entries for a specific document (call on Root unmount). */
	invalidateDocument(documentId: string): void {
		this.invalidatedDocs.add(documentId);
		for (const [k, entry] of this.cache) {
			if (k.startsWith(`${documentId}-`)) {
				entry.bitmap.close();
				this.cache.delete(k);
			}
		}
		// Clean up the invalidated set after a tick to catch any in-flight calls,
		// then allow future caching if the same document is reopened.
		setTimeout(() => {
			this.invalidatedDocs.delete(documentId);
		}, 1000);
	}

	clear(): void {
		for (const entry of this.cache.values()) {
			entry.bitmap.close();
		}
		this.cache.clear();
		this.invalidatedDocs.clear();
	}
}

export const renderCache = new RenderCache();
