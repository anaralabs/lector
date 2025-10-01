import { useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

export const useCanvasLayer = ({ background }: { background?: string }) => {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const pageNumber = usePDFPageNumber();

	const dpr = useDpr();

	const bouncyZoom = usePdf((state) => state.zoom);
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

	const [zoom] = useDebounce(bouncyZoom, 100);

	// const { visible } = useVisibility({ elementRef: canvasRef });
	// const debouncedVisible = useDebounce(visible, 100);

	useLayoutEffect(() => {
		if (!canvasRef.current) {
			return;
		}

		const viewport = pdfPageProxy.getViewport({ scale: 1 });

		const canvas = canvasRef.current;

		const scale = dpr * zoom;

		// Check Safari canvas size limits
		// Safari has a max canvas area of ~16,777,216 pixels (4096x4096)
		// and max dimension of ~32,767 pixels per side
		const MAX_CANVAS_PIXELS = 16777216;
		const MAX_CANVAS_DIMENSION = 32767;

		const proposedHeight = viewport.height * scale;
		const proposedWidth = viewport.width * scale;
		const proposedArea = proposedHeight * proposedWidth;

		// Clamp scale if we exceed Safari's limits
		if (
			proposedArea > MAX_CANVAS_PIXELS ||
			proposedHeight > MAX_CANVAS_DIMENSION ||
			proposedWidth > MAX_CANVAS_DIMENSION
		) {
			console.log("Safari canvas size limits exceeded");
		}

		canvas.height = viewport.height * scale;
		canvas.width = viewport.width * scale;

		canvas.style.height = `${viewport.height}px`;
		canvas.style.width = `${viewport.width}px`;

		const canvasContext = canvas.getContext("2d")!;
		canvasContext.scale(scale, scale);

		const renderingTask = pdfPageProxy.render({
			canvasContext: canvasContext,
			viewport,
			background,
		});

		renderingTask.promise.catch((error) => {
			if (error.name === "RenderingCancelledException") {
				return;
			}

			throw error;
		});

		return () => {
			void renderingTask.cancel();
		};
	}, [pdfPageProxy, zoom, background, dpr]);

	return {
		canvasRef,
	};
};
