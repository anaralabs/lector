import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { clampScaleForPage } from "../../lib/canvas-utils";
import { renderCache } from "../../lib/render-cache";
import { renderQueue } from "../../lib/render-queue";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

export const useCanvasLayer = ({ background }: { background?: string }) => {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const pageNumber = usePDFPageNumber();
	const previousPageNumberRef = useRef(pageNumber);
	const cleanupStateRef = useRef({
		pageNumber,
		unmarkPageRendered: (_pageNumber: number) => {},
	});

	const dpr = useDpr();

	const bouncyZoom = usePdf((state) => state.zoom);
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const markPageRendered = usePdf((state) => state.markPageRendered);
	const unmarkPageRendered = usePdf((state) => state.unmarkPageRendered);
	const documentId = usePdf(
		(state) => state.pdfDocumentProxy.fingerprints[0] ?? "default",
	);

	const [zoom] = useDebounce(bouncyZoom, 100);

	useEffect(() => {
		cleanupStateRef.current = {
			pageNumber,
			unmarkPageRendered,
		};
	}, [pageNumber, unmarkPageRendered]);

	// Track the last rendered state to skip redundant renders
	const lastRenderedScaleRef = useRef(0);
	const lastBackgroundRef = useRef(background);
	const lastPageProxyRef = useRef(pdfPageProxy);

	// useLayoutEffect for cache hits — synchronous draw before paint, no flash.
	// Cache misses enqueue async work via the render queue (non-blocking).
	useLayoutEffect(() => {
		if (!canvasRef.current) {
			return;
		}

		// Reset when the page or background changes so we force a re-render
		if (
			lastPageProxyRef.current !== pdfPageProxy ||
			lastBackgroundRef.current !== background
		) {
			lastPageProxyRef.current = pdfPageProxy;
			lastBackgroundRef.current = background;
			lastRenderedScaleRef.current = 0;
		}

		const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
		const pageWidth = baseViewport.width;
		const pageHeight = baseViewport.height;
		const bgColor = background ?? "white";

		const targetBaseScale = dpr * Math.min(zoom, 1);
		const baseScale = clampScaleForPage(targetBaseScale, pageWidth, pageHeight);

		// Skip re-render if scale hasn't changed
		if (baseScale === lastRenderedScaleRef.current) {
			return;
		}

		const w = Math.floor(pageWidth * baseScale);
		const h = Math.floor(pageHeight * baseScale);
		const cssText = `position:absolute;top:0;left:0;width:${pageWidth}px;height:${pageHeight}px;transform:translate(0px,0px);z-index:0;pointer-events:none;background-color:${bgColor}`;

		// Helper to paint a source onto the visible canvas
		const swapToCanvas = (
			source: ImageBitmap | HTMLCanvasElement,
			sw: number,
			sh: number,
		) => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			canvas.width = sw;
			canvas.height = sh;
			canvas.style.cssText = cssText;
			const ctx = canvas.getContext("2d");
			if (ctx) {
				ctx.drawImage(source, 0, 0);
			}
			lastRenderedScaleRef.current = baseScale;
		};

		// Check bitmap cache — instant synchronous draw, no PDF.js render needed.
		// Since this is useLayoutEffect, the draw happens before browser paint = no flash.
		const cached = renderCache.get(
			documentId,
			pageNumber,
			baseScale,
			background,
		);
		if (cached) {
			swapToCanvas(cached.bitmap, cached.width, cached.height);
			markPageRendered(pageNumber);
			return;
		}

		let cancelled = false;
		let activeRenderingTask: { cancel(): void } | null = null;

		// Cache miss — render via queue with double-buffer (async, non-blocking)
		const job = renderQueue.enqueue(() => {
			return new Promise<void>((resolve, reject) => {
				if (cancelled || !canvasRef.current) {
					resolve();
					return;
				}

				// Double-buffer: render to a temporary canvas, then swap onto the
				// visible canvas in a single frame to avoid white flash
				const buffer = document.createElement("canvas");
				buffer.width = w;
				buffer.height = h;

				const bufferCtx = buffer.getContext("2d");
				if (!bufferCtx) {
					resolve();
					return;
				}

				const viewport = pdfPageProxy.getViewport({ scale: baseScale });

				const renderingTask = pdfPageProxy.render({
					canvas: buffer,
					canvasContext: bufferCtx,
					viewport,
					background,
				});
				activeRenderingTask = renderingTask;

				renderingTask.promise
					.then(() => {
						activeRenderingTask = null;
						if (cancelled || !canvasRef.current) {
							resolve();
							return;
						}

						swapToCanvas(buffer, w, h);
						markPageRendered(pageNumber);

						// Cache for instant scroll-back, then release buffer
						renderCache
							.set(documentId, pageNumber, baseScale, buffer, background)
							.finally(() => {
								// Release buffer canvas memory (Safari holds onto it)
								// Only after createImageBitmap has read the pixels
								buffer.width = 0;
								buffer.height = 0;
							});

						resolve();
					})
					.catch((error) => {
						activeRenderingTask = null;
						if (error.name === "RenderingCancelledException") {
							resolve();
							return;
						}
						reject(error);
					});
			});
		});

		return () => {
			cancelled = true;
			job.cancel();
			void activeRenderingTask?.cancel();
		};
	}, [
		pdfPageProxy,
		background,
		dpr,
		zoom,
		pageNumber,
		documentId,
		markPageRendered,
	]);

	// Unmark the previous page when this layer is reused for a different page.
	useEffect(() => {
		const previousPageNumber = previousPageNumberRef.current;
		previousPageNumberRef.current = pageNumber;

		if (previousPageNumber !== pageNumber) {
			unmarkPageRendered(previousPageNumber);
		}
	}, [pageNumber, unmarkPageRendered]);

	// Cleanup on unmount only: unmark the currently rendered page.
	// Avoid shrinking the backing store to 1x1 here; under fast virtualization
	// and React Strict Mode this can leave a visible blank/white page while the
	// next render job is still queued. Browsers reclaim detached canvas memory
	// well enough here, and correctness during fast scroll matters more.
	useEffect(() => {
		return () => {
			const { pageNumber: currentPageNumber, unmarkPageRendered } =
				cleanupStateRef.current;
			unmarkPageRendered(currentPageNumber);
		};
		// Intentionally empty dependency array: this cleanup should only run on
		// true unmount, not when the virtualized page component is reused for a
		// different page number.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return {
		canvasRef,
	};
};
