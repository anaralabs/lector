import { useCallback, useEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
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

		// Skip re-render if scale hasn't changed (e.g. zoom > 1 doesn't affect base canvas)
		if (baseScale === lastRenderedScaleRef.current) {
			return;
		}

		let cancelled = false;
		// Mutable object so the cleanup function always cancels the latest render,
		// even when a hi-res job is enqueued asynchronously inside a .then()
		const cancelRef = { current: () => {} };

		const job = renderQueue.enqueue(() => {
			return new Promise<void>((resolve, reject) => {
				if (cancelled || !canvasRef.current) {
					resolve();
					return;
				}

				const w = Math.floor(pageWidth * baseScale);
				const h = Math.floor(pageHeight * baseScale);

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

						// Swap: copy the completed render onto the visible canvas
						const canvas = canvasRef.current;
						canvas.width = w;
						canvas.height = h;
						canvas.style.cssText = `position:absolute;top:0;left:0;width:${pageWidth}px;height:${pageHeight}px;transform:translate(0px,0px);z-index:0;pointer-events:none;background-color:${bgColor}`;

						const ctx = canvas.getContext("2d");
						if (ctx) {
							ctx.drawImage(buffer, 0, 0);
						}

						lastRenderedScaleRef.current = baseScale;
						resolve();
					})
					.catch((error) => {
						if (error.name === "RenderingCancelledException") {
							resolve();
							return;
						}
						reject(error);
					});

				// Store cancel handle so cleanup always cancels the latest render
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

	// Release canvas memory for Safari on unmount only (not between re-renders,
	// which would cause a visible white flash during zoom)
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
