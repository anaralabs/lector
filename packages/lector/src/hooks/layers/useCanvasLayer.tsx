import type { PDFPageProxy } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { clampScaleForPage } from "../../lib/canvas-utils";
import { createDarkModeColorMap } from "../../lib/dark-mode";
import { applyContextRecolor } from "../../lib/recolor-context";
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

function cacheKey(
	scale: number,
	background?: string,
	recolorKey?: string,
): number {
	const bg = `${background ?? "white"}|${recolorKey ?? ""}`;
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
	recolorKey?: string,
): ImageBitmap | null {
	const key = cacheKey(scale, background, recolorKey);
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
	recolorKey: string | undefined,
	bitmap: ImageBitmap,
): void {
	const key = cacheKey(scale, background, recolorKey);
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
	// Key (background|scheme) the currently painted frame was rendered with,
	// or null when the canvas holds no content.
	const paintedKeyRef = useRef<string | null>(null);
	const pageNumber = usePDFPageNumber();

	const dpr = useDpr();

	const bouncyZoom = usePdf((state) => state.zoom);
	const isResizing = usePdf((state) => state.isResizing);
	const docId = usePdf((state) => state.pdfDocumentProxy.fingerprints[0] ?? "");
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const markPageRendered = usePdf((state) => state.markPageRendered);
	const unmarkPageRendered = usePdf((state) => state.unmarkPageRendered);
	const colorScheme = usePdf((state) => state.colorScheme);
	const darkModeColors = usePdf((state) => state.darkModeColors);

	// Memoized per palette — stable identity, safe as an effect dependency.
	const recolor =
		colorScheme === "dark" ? createDarkModeColorMap(darkModeColors) : null;
	const recolorKey = recolor
		? `dark:${darkModeColors.background},${darkModeColors.foreground}`
		: undefined;

	const [zoom] = useDebounce(bouncyZoom, 100);

	useLayoutEffect(() => {
		if (!canvasRef.current) return;

		const baseCanvas = canvasRef.current;
		const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
		const pageWidth = baseViewport.width;
		const pageHeight = baseViewport.height;

		const contentKey = `${background ?? "white"}|${recolorKey ?? ""}`;

		// Mid-resize, reuse the painted frame via CSS — but only if one exists
		// AND it was painted with the current scheme/background, else we'd
		// un-hide a cleared canvas (blank for the drag) or show stale colors
		// after a theme toggle that lands during the resize.
		if (isResizing && paintedKeyRef.current === contentKey) {
			baseCanvas.style.visibility = "";
			baseCanvas.style.width = `${pageWidth}px`;
			baseCanvas.style.height = `${pageHeight}px`;
			return;
		}

		paintedKeyRef.current = null;

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
		// In dark mode the painted pixels get the mapped background (pdf.js
		// fills it through the recolored fillRect), so the CSS fallback color
		// must match — otherwise unpainted frames flash light.
		baseCanvas.style.backgroundColor = recolor
			? recolor(background ?? "#ffffff")
			: (background ?? "white");
		baseCanvas.style.visibility = "";

		const context = baseCanvas.getContext("2d");
		if (!context) return;

		const cached = getCachedBitmap(
			pdfPageProxy,
			baseScale,
			background,
			recolorKey,
		);
		if (cached) {
			context.drawImage(cached, 0, 0);
			markPageRendered(pageNumber);
			paintedKeyRef.current = contentKey;
			return;
		}

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, baseCanvas.width, baseCanvas.height);

		baseCanvas.style.visibility = "hidden";

		let cancelled = false;
		const viewport = pdfPageProxy.getViewport({ scale: baseScale });

		// Render into a detached buffer, never the in-DOM canvas: pdf.js calls
		// ctx.font / measureText during rendering, and those force a full
		// document style-recalc when run on an attached canvas — pathological
		// under large stylesheets (Tailwind v4's @property custom props), to the
		// tune of ~6ms per call. Off-DOM the same ops are free; we blit the
		// finished frame onto the visible canvas in one drawImage. If a second
		// 2D context can't be allocated (canvas memory pressure), fall back to
		// rendering directly into the visible canvas so the page still renders.
		const buffer = document.createElement("canvas");
		buffer.width = baseCanvas.width;
		buffer.height = baseCanvas.height;
		const bufferCtx = buffer.getContext("2d");
		const useBuffer = bufferCtx !== null;
		const renderCanvas = useBuffer ? buffer : baseCanvas;
		const renderCtx = bufferCtx ?? context;

		// Native dark mode: recolor at draw time inside this render. The
		// `background` param stays the ORIGINAL color — pdf.js fills it through
		// the wrapped fillRect, which maps it exactly once.
		const restoreRecolor = recolor
			? applyContextRecolor(renderCtx, recolor)
			: null;

		const renderingTask = pdfPageProxy.render({
			canvas: renderCanvas,
			canvasContext: renderCtx,
			viewport,
			background,
		});

		const releaseBuffer = () => {
			buffer.width = 0;
			buffer.height = 0;
		};

		renderingTask.promise
			.finally(() => {
				// Matters for the no-buffer fallback, where renderCtx is the
				// long-lived visible canvas context.
				restoreRecolor?.();
			})
			.then(() => {
				if (cancelled) {
					releaseBuffer();
					return;
				}
				if (useBuffer) {
					// Clear before blitting: drawImage composites source-over, so on
					// a page with transparent regions (or a transparent background)
					// any pixels already on the canvas would show through. The render
					// task resolves async, so don't rely on the clear at effect start.
					context.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
					context.drawImage(buffer, 0, 0);
				}
				baseCanvas.style.visibility = "";
				markPageRendered(pageNumber);
				paintedKeyRef.current = contentKey;
				if (typeof createImageBitmap !== "undefined") {
					createImageBitmap(renderCanvas)
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
								recolorKey,
								bitmap,
							);
						})
						.catch(() => {})
						.finally(releaseBuffer);
				} else {
					releaseBuffer();
				}
			})
			.catch((error) => {
				releaseBuffer();
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
		isResizing,
		pageNumber,
		markPageRendered,
		docId,
		recolor,
		recolorKey,
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
