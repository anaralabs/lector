import type { PDFDocumentProxy } from "pdfjs-dist";

const MAX_ENTRIES = 20;

interface CacheEntry {
	bitmap: ImageBitmap;
	key: string;
	lastAccess: number;
}

class BitmapCache {
	private entries = new Map<string, CacheEntry>();
	private documentId: string | null = null;

	private makeKey(pageNumber: number, scale: number): string {
		return `p${pageNumber}-s${Math.round(scale * 1000)}`;
	}

	bindDocument(doc: PDFDocumentProxy) {
		const newId = doc.fingerprints[0] ?? "";
		if (newId !== this.documentId) {
			this.invalidateAll();
			this.documentId = newId;
		}
	}

	get(pageNumber: number, scale: number): ImageBitmap | null {
		const key = this.makeKey(pageNumber, scale);
		const entry = this.entries.get(key);
		if (!entry) return null;
		entry.lastAccess = performance.now();
		return entry.bitmap;
	}

	set(pageNumber: number, scale: number, bitmap: ImageBitmap) {
		const key = this.makeKey(pageNumber, scale);

		const existing = this.entries.get(key);
		if (existing) {
			existing.bitmap.close();
		}

		this.entries.set(key, { bitmap, key, lastAccess: performance.now() });
		this.evict();
	}

	has(pageNumber: number, scale: number): boolean {
		return this.entries.has(this.makeKey(pageNumber, scale));
	}

	private evict() {
		while (this.entries.size > MAX_ENTRIES) {
			let oldest: CacheEntry | null = null;
			for (const entry of this.entries.values()) {
				if (!oldest || entry.lastAccess < oldest.lastAccess) {
					oldest = entry;
				}
			}
			if (oldest) {
				oldest.bitmap.close();
				this.entries.delete(oldest.key);
			}
		}
	}

	invalidateAll() {
		for (const entry of this.entries.values()) {
			entry.bitmap.close();
		}
		this.entries.clear();
	}
}

export const bitmapCache = new BitmapCache();
