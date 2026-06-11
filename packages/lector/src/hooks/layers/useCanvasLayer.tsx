import type { PDFPageProxy } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { PDFStore, usePdf } from "../../internal";
import { computeBaseScale, IS_MOBILE_DEVICE } from "../../lib/canvas-utils";
import { createDarkModeColorMap } from "../../lib/dark-mode";
import {
	applyContextRecolor,
	removeContextRecolor,
} from "../../lib/recolor-context";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const CACHE_MAX_ENTRIES = 60;

// The cache is budgeted in BYTES, not entries: entries vary from ~2MB
// (fit-width letter page) to ~64MB (budget-clamped high-zoom page), so an
// entry count alone can pin hundreds of MB of ImageBitmaps. Mobile budgets
// are conservative because canvases count toward the page's jetsam memory
// limit on iOS.
const CACHE_MAX_BYTES = (IS_MOBILE_DEVICE ? 64 : 192) * 1024 * 1024;
// A single bitmap near the budget would evict most of the cache for one
// entry — frames that big are cheaper to re-render than to cache. The
// mobile divisor must leave room for a letter/A4 page at dpr 3 (~17.5MB),
// the everyday frame on the phones the cache exists for.
const CACHE_MAX_ENTRY_BYTES = IS_MOBILE_DEVICE
	? CACHE_MAX_BYTES / 3
	: CACHE_MAX_BYTES / 4;
// Old scales/schemes of the same page are near-duplicates; keep only the
// most recent few so a zoom session doesn't fill the cache with one page.
const MAX_VARIANTS_PER_PROXY = 2;

type CacheEntry = {
	docId: string;
	proxy: PDFPageProxy;
	key: number;
	bitmap: ImageBitmap;
	bytes: number;
};
const cacheEntries: CacheEntry[] = [];
const canvasBitmapCache = new WeakMap<PDFPageProxy, Map<number, ImageBitmap>>();
let cacheBytes = 0;

function evictEntryAt(index: number): void {
	const [entry] = cacheEntries.splice(index, 1);
	if (!entry) return;
	cacheBytes -= entry.bytes;
	const map = canvasBitmapCache.get(entry.proxy);
	if (map?.get(entry.key) === entry.bitmap) {
		map.delete(entry.key);
	}
	entry.bitmap.close();
}

export function clearBitmapCache(documentId?: string): void {
	for (let i = cacheEntries.length - 1; i >= 0; i--) {
		if (documentId === undefined || cacheEntries[i]!.docId === documentId) {
			evictEntryAt(i);
		}
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
	const bytes = bitmap.width * bitmap.height * 4;
	if (bytes > CACHE_MAX_ENTRY_BYTES) {
		bitmap.close();
		return;
	}
	const key = cacheKey(scale, background, recolorKey);
	const existingIdx = cacheEntries.findIndex(
		(e) => e.proxy === proxy && e.key === key,
	);
	if (existingIdx !== -1) {
		if (cacheEntries[existingIdx]!.bitmap === bitmap) return;
		evictEntryAt(existingIdx);
	}
	let map = canvasBitmapCache.get(proxy);
	if (!map) {
		map = new Map();
		canvasBitmapCache.set(proxy, map);
	}
	map.set(key, bitmap);
	cacheEntries.push({ docId, proxy, key, bitmap, bytes });
	cacheBytes += bytes;

	// Trim stale variants of this page (older scales/schemes), newest first.
	let variants = 0;
	for (let i = cacheEntries.length - 1; i >= 0; i--) {
		if (cacheEntries[i]!.proxy !== proxy) continue;
		variants++;
		if (variants > MAX_VARIANTS_PER_PROXY) {
			evictEntryAt(i);
		}
	}

	while (
		cacheEntries.length > 0 &&
		(cacheEntries.length > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES)
	) {
		evictEntryAt(0);
	}
}

export const useCanvasLayer = ({ background }: { background?: string }) => {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	// What the visible canvas currently shows — page proxy, scheme/background
	// key, and the backing scale it was rendered at — or null when it holds no
	// content. The proxy guards against a recycled component showing another
	// page's frame.
	const paintedRef = useRef<{
		proxy: PDFPageProxy;
		key: string;
		scale: number;
	} | null>(null);
	const pageNumber = usePDFPageNumber();
	const store = PDFStore.useContext();

	const dpr = useDpr();

	const bouncyZoom = usePdf((state) => state.zoom);
	const isResizing = usePdf((state) => state.isResizing);
	const isPinching = usePdf((state) => state.isPinching);
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
		const baseScale = computeBaseScale(dpr, zoom, pageWidth, pageHeight);
		const hasCurrentFrame =
			paintedRef.current?.proxy === pdfPageProxy &&
			paintedRef.current?.key === contentKey;

		// When neither the backing scale nor the scheme changed (gesture-flag
		// flips, scheme-unchanged re-runs, budget-clamped zooms that resolve
		// to the same scale) there is nothing to do — and touching
		// canvas.width would clear the bitmap.
		if (hasCurrentFrame && paintedRef.current?.scale === baseScale) {
			return;
		}

		// Mid-gesture (fit-width resize drag, pinch), reuse the painted frame
		// via CSS — the stack transform scales it coherently — and re-render
		// once the gesture settles. Only valid when the frame matches the
		// current scheme/background, else we'd show stale colors. Geometry
		// styles are left untouched: the inverse-scale scheme below keeps the
		// canvas page-glued at any live zoom.
		if ((isResizing || isPinching) && hasCurrentFrame) {
			baseCanvas.style.visibility = "";
			return;
		}

		// CSS-only writes — never touch the backing store here, a same-scheme
		// previous frame may still be on display while the new one renders.
		//
		// Inverse-scale trick (same as the detail overlay): the canvas is laid
		// out at zoom-scaled size and counter-scaled by 1/zoom, so its NET
		// transform under the stack's scale3d(zoom) is identity. Safari samples
		// canvases under a non-identity composited scale with unsnapped
		// bilinear filtering — visibly soft text even at a 1:1 pixel ratio —
		// while ~identity-transformed layers get pixel-snapped and stay crisp.
		// Net page-coordinate extent is (pageWidth*zoom)/zoom = pageWidth for
		// any zoom, so geometry stays exact even when a stale frame is shown
		// under a different live zoom.
		baseCanvas.style.position = "absolute";
		baseCanvas.style.top = "0";
		baseCanvas.style.left = "0";
		baseCanvas.style.width = `${pageWidth * zoom}px`;
		baseCanvas.style.height = `${pageHeight * zoom}px`;
		baseCanvas.style.transform = `scale3d(${1 / zoom},${1 / zoom},1)`;
		baseCanvas.style.transformOrigin = "0 0";
		baseCanvas.style.zIndex = "0";
		baseCanvas.style.pointerEvents = "none";
		// In dark mode the painted pixels get the mapped background (pdf.js
		// fills it through the recolored fillRect), so the CSS fallback color
		// must match — otherwise unpainted frames flash light.
		baseCanvas.style.backgroundColor = recolor
			? recolor(background ?? "#ffffff")
			: (background ?? "white");

		const backingWidth = Math.floor(pageWidth * baseScale);
		const backingHeight = Math.floor(pageHeight * baseScale);

		const context = baseCanvas.getContext("2d");
		if (!context) {
			// Context allocation failed (canvas memory pressure). If the canvas
			// shows another page's or scheme's pixels, blank it — wrong content
			// is worse than a hidden canvas. A matching frame can stay.
			if (!hasCurrentFrame) {
				paintedRef.current = null;
				baseCanvas.width = backingWidth;
				baseCanvas.height = backingHeight;
				baseCanvas.style.visibility = "hidden";
			}
			return;
		}

		const applyBackingSize = () => {
			// Assigning width/height clears the canvas, even to the same value.
			baseCanvas.width = backingWidth;
			baseCanvas.height = backingHeight;
		};

		const cached = getCachedBitmap(
			pdfPageProxy,
			baseScale,
			background,
			recolorKey,
		);
		if (cached) {
			applyBackingSize();
			context.drawImage(cached, 0, 0);
			baseCanvas.style.visibility = "";
			markPageRendered(pageNumber);
			paintedRef.current = {
				proxy: pdfPageProxy,
				key: contentKey,
				scale: baseScale,
			};
			return;
		}

		// Keep a same-scheme previous frame visible (CSS-stretched) while the
		// replacement renders off-DOM — no blank flash at zoom/dpr changes.
		// Only when the canvas holds nothing useful do we clear and hide.
		const hideUntilPainted = () => {
			paintedRef.current = null;
			applyBackingSize();
			baseCanvas.style.visibility = "hidden";
		};
		if (!hasCurrentFrame) {
			hideUntilPainted();
		}

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
		buffer.width = backingWidth;
		buffer.height = backingHeight;
		const bufferCtx = buffer.getContext("2d");
		const useBuffer = bufferCtx !== null;
		if (!useBuffer && hasCurrentFrame) {
			// The fallback draws straight into the visible canvas — the previous
			// frame can't survive that.
			hideUntilPainted();
		}
		const renderCanvas = useBuffer ? buffer : baseCanvas;
		const renderCtx = bufferCtx ?? context;

		const releaseBuffer = () => {
			buffer.width = 0;
			buffer.height = 0;
		};

		// Native dark mode: recolor at draw time inside this render. The
		// `background` param stays the ORIGINAL color — pdf.js fills it through
		// the wrapped fillRect, which maps it exactly once. For light renders,
		// strip any wrapper a still-pending dark render may have left on the
		// context (matters in the no-buffer fallback, where renderCtx is the
		// long-lived visible canvas context).
		let restoreRecolor: (() => void) | null = null;
		if (recolor) {
			restoreRecolor = applyContextRecolor(renderCtx, recolor);
		} else {
			removeContextRecolor(renderCtx);
		}

		let renderingTask: ReturnType<typeof pdfPageProxy.render>;
		try {
			renderingTask = pdfPageProxy.render({
				canvas: renderCanvas,
				canvasContext: renderCtx,
				viewport,
				background,
			});
		} catch (error) {
			// A synchronous render() throw would otherwise skip the
			// promise-based restore and leave the long-lived context wrapped.
			restoreRecolor?.();
			releaseBuffer();
			throw error;
		}

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
				// A scheme toggle mutates the shared render color map immediately,
				// before React's cleanup cancels this task — a render finishing in
				// that one-frame window may have painted pdf.js scratch canvases
				// (transparency groups, masks) with the NEW map while the rest
				// used the old one. Drop the frame instead of blitting/caching a
				// mixed-scheme bitmap; the effect re-run repaints right after.
				const state = store.getState();
				const currentRecolorKey =
					state.colorScheme === "dark"
						? `dark:${state.darkModeColors.background},${state.darkModeColors.foreground}`
						: undefined;
				if (currentRecolorKey !== recolorKey) {
					releaseBuffer();
					return;
				}
				if (useBuffer) {
					// Swap: size (which clears) and blit in one go — the previous
					// frame stays on screen up to this exact paint.
					applyBackingSize();
					context.drawImage(buffer, 0, 0);
				}
				baseCanvas.style.visibility = "";
				markPageRendered(pageNumber);
				paintedRef.current = {
					proxy: pdfPageProxy,
					key: contentKey,
					scale: baseScale,
				};
				if (
					typeof createImageBitmap !== "undefined" &&
					renderCanvas.width * renderCanvas.height * 4 <= CACHE_MAX_ENTRY_BYTES
				) {
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
		isPinching,
		pageNumber,
		markPageRendered,
		docId,
		recolor,
		recolorKey,
		store,
	]);

	useEffect(() => {
		const canvas = canvasRef.current;
		return () => {
			unmarkPageRendered(pageNumber);
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
			// Keep the "paintedRef non-null implies the canvas holds that
			// frame" invariant — under StrictMode this cleanup runs on a
			// simulated unmount and the component lives on with the same refs;
			// without this the no-op early return would keep a blank canvas.
			paintedRef.current = null;
		};
	}, [pageNumber, unmarkPageRendered]);

	return {
		canvasRef,
	};
};
