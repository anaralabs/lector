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

	// Track the last successfully rendered scale to avoid redundant low-res passes
	const lastRenderedScaleRef = useRef(0);
	const lastPageProxyRef = useRef(pdfPageProxy);

	useEffect(() => {
		if (!canvasRef.current) {
			return;
		}

		// Only reset when the page changes, not on every zoom/dpr change
		if (lastPageProxyRef.current !== pdfPageProxy) {
			lastPageProxyRef.current = pdfPageProxy;
			lastRenderedScaleRef.current = 0;
		}

		const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
		const pageWidth = baseViewport.width;
		const pageHeight = baseViewport.height;
		const bgColor = background ?? "white";

		const targetBaseScale = dpr * Math.min(zoom, 1);
		const fullScale = clampScaleForPage(targetBaseScale, pageWidth, pageHeight);

		// Skip re-render if scale hasn't changed (e.g. zoom > 1 doesn't affect base canvas)
		if (fullScale === lastRenderedScaleRef.current) {
			return;
		}

		// Progressive rendering: if DPR > 1, render at 1x first, then upgrade
		const needsProgressive = dpr > 1 && lastRenderedScaleRef.current === 0;
		const lowScale = needsProgressive
			? clampScaleForPage(1 * Math.min(zoom, 1), pageWidth, pageHeight)
			: fullScale;

		let cancelled = false;
		// Mutable object so the cleanup function always cancels the latest render,
		// even when a hi-res job is enqueued asynchronously inside a .then()
		const cancelRef = { current: () => {} };

		// Double-buffer: render to a temporary canvas, then swap onto the visible
		// canvas in a single frame. This prevents the white flash that would occur
		// if we cleared the visible canvas before the render completed.
		const renderAtScale = (scale: number): Promise<void> => {
			return new Promise<void>((resolve, reject) => {
				if (cancelled || !canvasRef.current) {
					resolve();
					return;
				}

				const w = Math.floor(pageWidth * scale);
				const h = Math.floor(pageHeight * scale);

				// Render to an offscreen buffer so the visible canvas keeps
				// its old content until the new render is complete
				const buffer = document.createElement("canvas");
				buffer.width = w;
				buffer.height = h;

				const bufferCtx = buffer.getContext("2d");
				if (!bufferCtx) {
					resolve();
					return;
				}

				const viewport = pdfPageProxy.getViewport({ scale });

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

						lastRenderedScaleRef.current = scale;
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
		};

		if (needsProgressive && lowScale < fullScale) {
			// Phase 1: Quick low-res render (queued)
			const lowRes = renderQueue.enqueue(() => renderAtScale(lowScale));
			cancelRef.current = lowRes.cancel;

			// Phase 2: Full-res upgrade (queued after low-res)
			lowRes.promise.then(() => {
				if (cancelled) return;
				const hiRes = renderQueue.enqueue(() => renderAtScale(fullScale));
				cancelRef.current = hiRes.cancel;
				hiRes.promise.catch(() => {});
			});
		} else {
			// Single render at full scale (queued)
			const job = renderQueue.enqueue(() => renderAtScale(fullScale));
			cancelRef.current = job.cancel;
		}

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
