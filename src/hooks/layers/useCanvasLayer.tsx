import type { PDFPageProxy } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { clampScaleForPage } from "../../lib/canvas-utils";
import { msSinceScroll } from "../../lib/scroll-activity";
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

// GPU sprinkle: render into an OffscreenCanvas when the browser supports it.
// This avoids the GPU->CPU readback that `createImageBitmap(liveCanvas)`
// would otherwise require for caching, and lets `transferToImageBitmap()`
// produce a GPU-resident bitmap that the display canvas can draw in a
// single GPU->GPU blit.
const supportsOffscreenCanvas =
	typeof OffscreenCanvas !== "undefined" &&
	// Some older browsers expose OffscreenCanvas but not a 2d context on it.
	(() => {
		try {
			const off = new OffscreenCanvas(1, 1);
			return !!off.getContext("2d");
		} catch {
			return false;
		}
	})();

const idle =
	typeof requestIdleCallback !== "undefined"
		? (fn: () => void) => requestIdleCallback(fn, { timeout: 500 })
		: (fn: () => void) => setTimeout(fn, 0);
const cancelIdle =
	typeof cancelIdleCallback !== "undefined"
		? (id: number) => cancelIdleCallback(id)
		: (id: number) => clearTimeout(id);

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

function cacheKey(scale: number, background?: string): number {
	// Quantise the scale before hashing so small zoom jitter (e.g. 1.051 vs
	// 1.052) still hits the same cache entry. Pdfjs already clamps scale to
	// pixel-perfect values per-viewport; 2-decimal precision is plenty.
	const quantScale = Math.round(scale * 100) / 100;
	const bg = background ?? "white";
	let hash = Math.round(quantScale * 1e4);
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
	const key = cacheKey(scale, background);
	const bitmap = canvasBitmapCache.get(proxy)?.get(key);
	if (!bitmap) return null;
	const idx = cacheEntries.findIndex((e) => e.proxy === proxy && e.key === key);
	if (idx !== -1 && idx !== cacheEntries.length - 1) {
		const [entry] = cacheEntries.splice(idx, 1);
		cacheEntries.push(entry!);
	}
	return bitmap;
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

// Returns delay (ms) before a given page should start rendering after the
// debounced zoom resolves. Pages near the current viewport render
// immediately; pages farther out get staggered so they don't pile up on
// a single frame.
function stagger(distanceFromCurrent: number): number {
	if (distanceFromCurrent <= 1) return 0;
	return Math.min(distanceFromCurrent * 20, 160);
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
	const currentPage = usePdf((state) => state.currentPage);

	const [zoom] = useDebounce(bouncyZoom, 100);

	// Remember what we last committed to the display canvas so we can skip
	// redundant width/height writes (each write reallocates the canvas's
	// GPU-backed texture).
	const lastCommittedRef = useRef<{ w: number; h: number } | null>(null);

	useLayoutEffect(() => {
		if (!canvasRef.current) return;

		const baseCanvas = canvasRef.current;
		const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
		const pageWidth = baseViewport.width;
		const pageHeight = baseViewport.height;

		const targetBaseScale = dpr * Math.min(zoom, 1);
		const baseScale = clampScaleForPage(targetBaseScale, pageWidth, pageHeight);

		const targetW = Math.floor(pageWidth * baseScale);
		const targetH = Math.floor(pageHeight * baseScale);

		const applyDimsIfNeeded = () => {
			if (
				lastCommittedRef.current?.w !== targetW ||
				lastCommittedRef.current?.h !== targetH
			) {
				baseCanvas.width = targetW;
				baseCanvas.height = targetH;
				lastCommittedRef.current = { w: targetW, h: targetH };
			}
		};

		baseCanvas.style.position = "absolute";
		baseCanvas.style.top = "0";
		baseCanvas.style.left = "0";
		baseCanvas.style.width = `${pageWidth}px`;
		baseCanvas.style.height = `${pageHeight}px`;
		baseCanvas.style.transform = "translate(0px, 0px)";
		baseCanvas.style.zIndex = "0";
		baseCanvas.style.pointerEvents = "none";
		baseCanvas.style.backgroundColor = background ?? "white";

		const ctx = baseCanvas.getContext("2d");
		if (!ctx) return;

		const cached = getCachedBitmap(pdfPageProxy, baseScale, background);
		if (cached) {
			applyDimsIfNeeded();
			// Setting canvas.width/height (when it changed) already cleared
			// the buffer. drawImage onto a GPU-backed ImageBitmap is a GPU->GPU
			// blit, no CPU readback.
			ctx.drawImage(cached, 0, 0);
			markPageRendered(pageNumber);
			return;
		}

		let cancelled = false;
		let renderingTask: ReturnType<PDFPageProxy["render"]> | null = null;
		let startTimeoutId: ReturnType<typeof setTimeout> | null = null;
		let idleHandle: number | null = null;

		// Intentionally do NOT hide the canvas here: pdfjs renders take many
		// frames on text-heavy pages, and hiding the canvas during that
		// window shows the parent's background (a white/dark flash). Let the
		// previous bitmap stay visible — when the new one is ready we swap
		// dims + drawImage synchronously so there's no user-visible gap.
		// (This is also the Firefox pinch-flash fix the lib already shipped.)

		const start = () => {
			if (cancelled) return;

			const viewport = pdfPageProxy.getViewport({ scale: baseScale });

			if (supportsOffscreenCanvas) {
				// GPU sprinkle: render into an OffscreenCanvas, then blit the
				// resulting GPU-resident ImageBitmap to the display canvas. No
				// GPU->CPU readback. The same bitmap is stored in the cache,
				// so subsequent redraws reuse it.
				const off = new OffscreenCanvas(targetW, targetH);
				const offCtx = off.getContext("2d");
				if (!offCtx) return;
				renderingTask = pdfPageProxy.render({
					// pdfjs types require HTMLCanvasElement + CanvasRenderingContext2D
					// but accept OffscreenCanvas + OffscreenCanvasRenderingContext2D
					// at runtime. Cast keeps the .d.ts clean.
					canvas: off as unknown as HTMLCanvasElement,
					canvasContext: offCtx as unknown as CanvasRenderingContext2D,
					viewport,
					background,
				});
				renderingTask.promise
					.then(() => {
						if (cancelled) return;
						const bitmap = off.transferToImageBitmap();
						applyDimsIfNeeded();
						ctx.drawImage(bitmap, 0, 0);
						markPageRendered(pageNumber);
						setCachedBitmap(
							docId,
							pdfPageProxy,
							baseScale,
							background,
							bitmap,
						);
					})
					.catch((error) => {
						if (cancelled) return;
						if (error?.name === "RenderingCancelledException") return;
						console.error("PDF render error:", error);
					});
				return;
			}

			// Fallback: render directly into the display canvas. Matches the
			// pre-OffscreenCanvas behaviour.
			applyDimsIfNeeded();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			renderingTask = pdfPageProxy.render({
				canvas: baseCanvas,
				canvasContext: ctx,
				viewport,
				background,
			});
			renderingTask.promise
				.then(() => {
					if (cancelled) return;
					markPageRendered(pageNumber);
					// Idle-defer the GPU->CPU readback so it doesn't steal the
					// frame that just finished rendering.
					if (typeof createImageBitmap === "undefined") return;
					idleHandle = idle(() => {
						idleHandle = null;
						if (cancelled) return;
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
					}) as number;
				})
				.catch((error) => {
					if (cancelled) return;
					if (error?.name === "RenderingCancelledException") return;
					console.error("PDF render error:", error);
				});
		};

		// Two delays stack:
		//   1. stagger by distance from the current page so a burst of
		//      mounts (e.g. after a pinch) doesn't all hit the main thread
		//      on the same frame.
		//   2. a scroll-idle wait so the expensive pdfjs render doesn't run
		//      while the user is actively flicking. pdfjs renders are
		//      synchronous main-thread work, and running them mid-flick is
		//      the primary cause of scroll jank when new pages enter view.
		const SCROLL_IDLE_MS = 120;
		const staggerDelay = stagger(
			Math.abs(pageNumber - (currentPage || pageNumber)),
		);

		const attemptStart = () => {
			if (cancelled) return;
			const sinceScroll = msSinceScroll();
			if (sinceScroll < SCROLL_IDLE_MS) {
				startTimeoutId = setTimeout(
					attemptStart,
					SCROLL_IDLE_MS - sinceScroll,
				);
				return;
			}
			startTimeoutId = null;
			start();
		};

		if (staggerDelay === 0) {
			attemptStart();
		} else {
			startTimeoutId = setTimeout(attemptStart, staggerDelay);
		}

		return () => {
			cancelled = true;
			if (startTimeoutId !== null) {
				clearTimeout(startTimeoutId);
				startTimeoutId = null;
			}
			if (idleHandle !== null) {
				cancelIdle(idleHandle);
				idleHandle = null;
			}
			void renderingTask?.cancel();
		};
	}, [
		pdfPageProxy,
		background,
		dpr,
		zoom,
		pageNumber,
		markPageRendered,
		docId,
		// currentPage only affects the initial stagger delay. Changes to
		// it while we're already rendering shouldn't cancel the render, so
		// we intentionally snapshot it via the closure above.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	]);

	useEffect(() => {
		const canvas = canvasRef.current;
		return () => {
			unmarkPageRendered(pageNumber);
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
			lastCommittedRef.current = null;
		};
	}, [pageNumber, unmarkPageRendered]);

	return {
		canvasRef,
	};
};
