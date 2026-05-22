import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import {
	getCachedBitmap,
	setCachedBitmap,
} from "../../lib/canvas-bitmap-cache";
import { clampScaleForPage } from "../../lib/canvas-utils";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

export { clearBitmapCache } from "../../lib/canvas-bitmap-cache";

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
