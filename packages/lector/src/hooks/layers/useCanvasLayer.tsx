import { useCallback, useEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { renderCache } from "../../lib/render-cache";
import { renderQueue } from "../../lib/render-queue";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const MAX_CANVAS_PIXELS = 16777216;
const MAX_CANVAS_DIMENSION = 32767;

export const useCanvasLayer = ({ background }: { background?: string }) => {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const pageNumber = usePDFPageNumber();

	const dpr = useDpr();

	const bouncyZoom = usePdf((state) => state.zoom);
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const markPageRendered = usePdf((state) => state.markPageRendered);

	const [zoom] = useDebounce(bouncyZoom, 100);

	const clampScaleForPage = useCallback(
		(targetScale: number, pageWidth: number, pageHeight: number) => {
			if (!targetScale) {
				return 0;
			}

			const areaLimit = Math.sqrt(
				MAX_CANVAS_PIXELS / Math.max(pageWidth * pageHeight, 1),
			);
			const widthLimit = MAX_CANVAS_DIMENSION / Math.max(pageWidth, 1);
			const heightLimit = MAX_CANVAS_DIMENSION / Math.max(pageHeight, 1);

			const safeScale = Math.min(
				targetScale,
				Number.isFinite(areaLimit) ? areaLimit : targetScale,
				Number.isFinite(widthLimit) ? widthLimit : targetScale,
				Number.isFinite(heightLimit) ? heightLimit : targetScale,
			);

			return Math.max(safeScale, 0);
		},
		[],
	);

	// Track the last rendered state to skip redundant renders
	const lastRenderedScaleRef = useRef(0);
	const lastBackgroundRef = useRef(background);
	const lastPageProxyRef = useRef(pdfPageProxy);

	useEffect(() => {
		if (!canvasRef.current) {
			return;
		}

		// Reset when the page or background changes so we force a re-render
		if (lastPageProxyRef.current !== pdfPageProxy || lastBackgroundRef.current !== background) {
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
		const swapToCanvas = (source: ImageBitmap | HTMLCanvasElement, sw: number, sh: number) => {
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

		// Check bitmap cache — instant draw, no PDF.js render needed
		const cached = renderCache.get(pageNumber, baseScale, background);
		if (cached) {
			swapToCanvas(cached.bitmap, cached.width, cached.height);
			markPageRendered(pageNumber);
			return;
		}

		let cancelled = false;
		const cancelRef = { current: () => {} };

		// Render via queue with double-buffer
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

				renderingTask.promise
					.then(() => {
						if (cancelled || !canvasRef.current) {
							resolve();
							return;
						}

						swapToCanvas(buffer, w, h);
						markPageRendered(pageNumber);

						// Cache in background for instant scroll-back
						void renderCache.set(pageNumber, baseScale, buffer, background);

						resolve();
					})
					.catch((error) => {
						if (error.name === "RenderingCancelledException") {
							resolve();
							return;
						}
						reject(error);
					});

				const prevCancel = cancelRef.current;
				cancelRef.current = () => {
					void renderingTask.cancel();
					prevCancel();
				};
			});
		});
		cancelRef.current = job.cancel;

		return () => {
			cancelled = true;
			cancelRef.current();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pdfPageProxy, background, dpr, zoom, clampScaleForPage]);

	// Release canvas memory for Safari on unmount only
	useEffect(() => {
		const canvas = canvasRef.current;
		return () => {
			if (canvas) {
				canvas.width = 1;
				canvas.height = 1;
			}
		};
	}, []);

	return {
		canvasRef,
	};
};
