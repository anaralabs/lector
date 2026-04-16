import type { PDFPageProxy } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { clampScaleForPage } from "../../lib/canvas-utils";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const CACHE_MAX = 60;

type CacheEntry = {
	docId: string;
	proxy: PDFPageProxy;
	key: number;
	bitmap: ImageBitmap;
};
const cacheEntries: CacheEntry[] = [];
const canvasBitmapCache = new WeakMap<PDFPageProxy, Map<number, ImageBitmap>>();

export function clearBitmapCache(documentId?: string): void {
	if (!documentId) {
		for (const entry of cacheEntries) {
			entry.bitmap.close();
			canvasBitmapCache.get(entry.proxy)?.delete(entry.key);
		}
		cacheEntries.length = 0;
		return;
	}
	for (let i = cacheEntries.length - 1; i >= 0; i--) {
		const entry = cacheEntries[i];
		if (entry.docId !== documentId) continue;
		entry.bitmap.close();
		canvasBitmapCache.get(entry.proxy)?.delete(entry.key);
		cacheEntries.splice(i, 1);
	}
}

function cacheKey(scale: number, background?: string): number {
	const bg = background ?? "white";
	let hash = Math.round(scale * 1e4);
	for (let i = 0; i < bg.length; i++) {
		hash = (hash * 31 + bg.charCodeAt(i)) | 0;
	}
	return hash;
}

function getCachedBitmap(
	proxy: PDFPageProxy,
	scale: number,
	background?: string,
): ImageBitmap | null {
	return canvasBitmapCache.get(proxy)?.get(cacheKey(scale, background)) ?? null;
}

function setCachedBitmap(
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

export const useCanvasLayer = ({ background }: { background?: string }) => {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const pageNumber = usePDFPageNumber();

	const dpr = useDpr();

	const bouncyZoom = usePdf((state) => state.zoom);
	const docId = usePdf((state) => state.pdfDocumentProxy.fingerprints[0] ?? "");
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const markPageRendered = usePdf((state) => state.markPageRendered);
	const unmarkPageRendered = usePdf((state) => state.unmarkPageRendered);

	const [zoom] = useDebounce(bouncyZoom, 100);

	useLayoutEffect(() => {
		if (!canvasRef.current) return;

		const baseCanvas = canvasRef.current;
		const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
		const pageWidth = baseViewport.width;
		const pageHeight = baseViewport.height;

		const targetBaseScale = dpr * Math.min(zoom, 1);
		const baseScale = clampScaleForPage(targetBaseScale, pageWidth, pageHeight);

		baseCanvas.width = Math.floor(pageWidth * baseScale);
		baseCanvas.height = Math.floor(pageHeight * baseScale);
		baseCanvas.style.position = "absolute";
		baseCanvas.style.top = "0";
		baseCanvas.style.left = "0";
		baseCanvas.style.width = `${pageWidth}px`;
		baseCanvas.style.height = `${pageHeight}px`;
		baseCanvas.style.transform = "translate(0px, 0px)";
		baseCanvas.style.zIndex = "0";
		baseCanvas.style.pointerEvents = "none";
		baseCanvas.style.backgroundColor = background ?? "white";
		baseCanvas.style.visibility = "";

		const context = baseCanvas.getContext("2d");
		if (!context) return;

		const cached = getCachedBitmap(pdfPageProxy, baseScale, background);
		if (cached) {
			context.drawImage(cached, 0, 0);
			markPageRendered(pageNumber);
			return;
		}

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, baseCanvas.width, baseCanvas.height);

		baseCanvas.style.visibility = "hidden";

		let cancelled = false;
		const viewport = pdfPageProxy.getViewport({ scale: baseScale });

		const renderingTask = pdfPageProxy.render({
			canvas: baseCanvas,
			canvasContext: context,
			viewport,
			background,
		});

		renderingTask.promise
			.then(() => {
				if (cancelled) return;
				baseCanvas.style.visibility = "";
				markPageRendered(pageNumber);
				if (typeof createImageBitmap !== "undefined") {
					createImageBitmap(baseCanvas)
						.then((bitmap) => {
							if (cancelled) {
								bitmap.close();
								return;
							}
							setCachedBitmap(
								docId,
								pdfPageProxy,
								baseScale,
								background,
								bitmap,
							);
						})
						.catch(() => {});
				}
			})
			.catch((error) => {
				if (cancelled) return;
				if (error?.name === "RenderingCancelledException") return;
				baseCanvas.style.visibility = "";
				console.error("PDF render error:", error);
			});

		return () => {
			cancelled = true;
			void renderingTask.cancel();
		};
	}, [
		pdfPageProxy,
		background,
		dpr,
		zoom,
		pageNumber,
		markPageRendered,
		docId,
	]);

	useEffect(() => {
		const canvas = canvasRef.current;
		return () => {
			unmarkPageRendered(pageNumber);
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
		};
	}, [pageNumber, unmarkPageRendered]);

	return {
		canvasRef,
	};
};
