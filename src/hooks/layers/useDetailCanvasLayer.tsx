import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const MAX_CANVAS_PIXELS = 16777216;
const MAX_CANVAS_DIMENSION = 32767;

export const useDetailCanvasLayer = ({
	background,
	baseCanvasRef,
}: {
	background?: string;
	baseCanvasRef: React.RefObject<HTMLCanvasElement | null>;
}) => {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const detailCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const pageNumber = usePDFPageNumber();

	const dpr = useDpr();

	const bouncyZoom = usePdf((state) => state.zoom);
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const viewportRef = usePdf((state) => state.viewportRef);

	const [zoom] = useDebounce(bouncyZoom, 200);
	const [scrollTick, setScrollTick] = useState(0);
	const [debouncedScrollTick] = useDebounce(scrollTick, 20);

	const ensureDetailCanvas = useCallback(() => {
		let detailCanvas = detailCanvasRef.current;
		if (!detailCanvas) {
			const parent = baseCanvasRef.current?.parentElement;
			if (!parent) {
				return null;
			}

			detailCanvas = document.createElement("canvas");
			parent.appendChild(detailCanvas);
			detailCanvasRef.current = detailCanvas;
		}

		detailCanvas.style.position = "absolute";
		detailCanvas.style.top = "0";
		detailCanvas.style.left = "0";
		detailCanvas.style.pointerEvents = "none";
		detailCanvas.style.zIndex = "0";

		return detailCanvas;
	}, [baseCanvasRef]);

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

	// Listen to scroll events to trigger re-renders
	useLayoutEffect(() => {
		const scrollContainer = viewportRef?.current;
		if (!scrollContainer) return;
		const handleScroll = () => {
			setScrollTick((prev) => prev + 1);
		};
		scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
		return () => {
			scrollContainer.removeEventListener("scroll", handleScroll);
		};
	}, [viewportRef?.current]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: debouncedScrollTick is intentionally added to trigger re-renders on scroll
	useLayoutEffect(() => {
		if (!viewportRef?.current) {
			return;
		}

		const detailCanvas = ensureDetailCanvas();
		const container = containerRef.current;
		if (!detailCanvas || !container) {
			return;
		}

		const scrollContainer = viewportRef.current;
		const pageContainer = baseCanvasRef.current?.parentElement ?? null;

		if (!pageContainer) {
			detailCanvas.style.display = "none";
			detailCanvas.width = 0;
			detailCanvas.height = 0;
			return;
		}

		const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
		const pageWidth = baseViewport.width;
		const pageHeight = baseViewport.height;

		const scrollX = scrollContainer.scrollLeft / zoom;
		const scrollY = scrollContainer.scrollTop / zoom;

		const viewportWidth = scrollContainer.clientWidth / zoom;
		const viewportHeight = scrollContainer.clientHeight / zoom;

		const pageRect = pageContainer.getBoundingClientRect();
		const containerRect = scrollContainer.getBoundingClientRect();

		const pageLeft = (pageRect.left - containerRect.left) / zoom + scrollX;
		const pageTop = (pageRect.top - containerRect.top) / zoom + scrollY;

		const visibleLeft = Math.max(0, scrollX - pageLeft);
		const visibleTop = Math.max(0, scrollY - pageTop);
		const visibleRight = Math.min(
			pageWidth,
			scrollX + viewportWidth - pageLeft,
		);
		const visibleBottom = Math.min(
			pageHeight,
			scrollY + viewportHeight - pageTop,
		);

		const visibleWidth = Math.max(0, visibleRight - visibleLeft);
		const visibleHeight = Math.max(0, visibleBottom - visibleTop);

		const targetDetailScale = dpr * zoom * 1.3;
		const baseTargetScale = dpr * Math.min(zoom, 1);
		const baseScale = clampScaleForPage(baseTargetScale, pageWidth, pageHeight);
		const needsDetail = zoom > 1 && targetDetailScale - baseScale > 1e-3;

		if (!needsDetail || visibleWidth <= 0 || visibleHeight <= 0) {
			detailCanvas.style.display = "none";
			detailCanvas.width = 0;
			detailCanvas.height = 0;
			return;
		}

		detailCanvas.style.display = "block";

		const pdfOffsetX = visibleLeft;
		const pdfOffsetY = visibleTop;

		const pdfWidth = visibleWidth * targetDetailScale;
		const pdfHeight = visibleHeight * targetDetailScale;

		const effectiveScale = targetDetailScale;
		const actualWidth = pdfWidth;
		const actualHeight = pdfHeight;

		detailCanvas.width = actualWidth;
		detailCanvas.height = actualHeight;

		const scaledWidth = visibleWidth * zoom;
		const scaledHeight = visibleHeight * zoom;

		detailCanvas.style.width = `${scaledWidth}px`;
		detailCanvas.style.height = `${scaledHeight}px`;

		detailCanvas.style.transformOrigin = "center center";
		detailCanvas.style.transform = `translate(${visibleLeft * zoom}px, ${visibleTop * zoom}px) `;
		container.style.transform = `scale3d(${1 / zoom}, ${1 / zoom}, 1)`;

		container.style.transformOrigin = `0 0`;
		const context = detailCanvas.getContext("2d");
		if (!context) {
			return;
		}

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, detailCanvas.width, detailCanvas.height);

		const transform = [
			1,
			0,
			0,
			1,
			-pdfOffsetX * effectiveScale,
			-pdfOffsetY * effectiveScale,
		];

		const detailViewport = pdfPageProxy.getViewport({ scale: effectiveScale });
		const renderingTask = pdfPageProxy.render({
			canvasContext: context,
			viewport: detailViewport,
			background,
			transform,
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
		// debouncedScrollTick is intentionally added to trigger re-renders on scroll
	}, [
		pdfPageProxy,
		zoom,
		background,
		dpr,
		viewportRef,
		ensureDetailCanvas,
		clampScaleForPage,
		baseCanvasRef,
		debouncedScrollTick,
	]);

	return {
		detailCanvasRef,
		containerRef,
	};
};
