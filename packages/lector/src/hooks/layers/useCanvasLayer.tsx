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

	useEffect(() => {
		if (!canvasRef.current) {
			return;
		}

		// Reset when page changes so progressive rendering always runs for new pages
		lastRenderedScaleRef.current = 0;

		const baseCanvas = canvasRef.current;
		const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
		const pageWidth = baseViewport.width;
		const pageHeight = baseViewport.height;

		const targetBaseScale = dpr * Math.min(zoom, 1);
		const fullScale = clampScaleForPage(targetBaseScale, pageWidth, pageHeight);

		// Progressive rendering: if DPR > 1, render at 1x first, then upgrade
		const needsProgressive = dpr > 1 && lastRenderedScaleRef.current !== fullScale;
		const lowScale = needsProgressive
			? clampScaleForPage(1 * Math.min(zoom, 1), pageWidth, pageHeight)
			: fullScale;

		let cancelled = false;
		// Mutable object so the cleanup function always cancels the latest render,
		// even when a hi-res job is enqueued asynchronously inside a .then()
		const cancelRef = { current: () => {} };

		const renderAtScale = (scale: number): Promise<void> => {
			return new Promise<void>((resolve, reject) => {
				if (cancelled || !canvasRef.current) {
					resolve();
					return;
				}

				const canvas = canvasRef.current;
				canvas.width = Math.floor(pageWidth * scale);
				canvas.height = Math.floor(pageHeight * scale);
				canvas.style.position = "absolute";
				canvas.style.top = "0";
				canvas.style.left = "0";
				canvas.style.width = `${pageWidth}px`;
				canvas.style.height = `${pageHeight}px`;
				canvas.style.transform = "translate(0px, 0px)";
				canvas.style.zIndex = "0";
				canvas.style.pointerEvents = "none";
				canvas.style.backgroundColor = background ?? "white";

				const context = canvas.getContext("2d");
				if (!context) {
					resolve();
					return;
				}

				context.setTransform(1, 0, 0, 1, 0, 0);
				context.clearRect(0, 0, canvas.width, canvas.height);

				const viewport = pdfPageProxy.getViewport({ scale });

				const renderingTask = pdfPageProxy.render({
					canvas,
					canvasContext: context,
					viewport,
					background,
				});

				renderingTask.promise
					.then(() => {
						if (!cancelled) {
							lastRenderedScaleRef.current = scale;
						}
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

	return {
		canvasRef,
	};
};
