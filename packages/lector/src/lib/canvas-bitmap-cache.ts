import type { PDFPageProxy } from "pdfjs-dist";

const CACHE_MAX = 512;

type CacheEntry = {
	docId: string;
	proxy: PDFPageProxy;
	key: number;
	bitmap: ImageBitmap;
};

const cacheEntries: CacheEntry[] = [];
const canvasBitmapCache = new WeakMap<PDFPageProxy, Map<number, ImageBitmap>>();

export function clearBitmapCache(documentId?: string): void {
	if (documentId === undefined) {
		for (const entry of cacheEntries) {
			entry.bitmap.close();
			canvasBitmapCache.get(entry.proxy)?.delete(entry.key);
		}
		cacheEntries.length = 0;
		return;
	}
	for (let i = cacheEntries.length - 1; i >= 0; i--) {
		const entry = cacheEntries[i]!;
		if (entry.docId !== documentId) continue;
		entry.bitmap.close();
		canvasBitmapCache.get(entry.proxy)?.delete(entry.key);
		cacheEntries.splice(i, 1);
	}
}

export function cacheKey(scale: number, background?: string): number {
	const bg = background ?? "white";
	let hash = Math.round(scale * 1e4);
	for (let i = 0; i < bg.length; i++) {
		hash = (hash * 31 + bg.charCodeAt(i)) | 0;
	}
	return hash;
}

export function getCachedBitmap(
	proxy: PDFPageProxy,
	scale: number,
	background?: string,
): ImageBitmap | null {
	const key = cacheKey(scale, background);
	const bitmap = canvasBitmapCache.get(proxy)?.get(key);
	if (!bitmap) return null;
	const idx = cacheEntries.findIndex(
		(e) => e.proxy === proxy && e.key === key,
	);
	if (idx !== -1 && idx !== cacheEntries.length - 1) {
		const [entry] = cacheEntries.splice(idx, 1);
		cacheEntries.push(entry!);
	}
	return bitmap;
}

export function setCachedBitmap(
	docId: string,
	proxy: PDFPageProxy,
	scale: number,
	background: string | undefined,
	bitmap: ImageBitmap,
): void {
	const key = cacheKey(scale, background);
	let map = canvasBitmapCache.get(proxy);
	if (!map) {
		map = new Map();
		canvasBitmapCache.set(proxy, map);
	}
	const existing = map.get(key);
	if (existing && existing !== bitmap) {
		existing.close();
		const idx = cacheEntries.findIndex(
			(e) => e.proxy === proxy && e.key === key,
		);
		if (idx !== -1) cacheEntries.splice(idx, 1);
	}
	map.set(key, bitmap);
	cacheEntries.push({ docId, proxy, key, bitmap });

	while (cacheEntries.length > CACHE_MAX) {
		const evicted = cacheEntries.shift()!;
		const evictedMap = canvasBitmapCache.get(evicted.proxy);
		if (evictedMap?.get(evicted.key) === evicted.bitmap) {
			evictedMap.delete(evicted.key);
			evicted.bitmap.close();
		}
	}
}
