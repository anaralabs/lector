import { useCallback, useLayoutEffect, useRef } from "react";
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

	const rafRef = useRef(0);
	const renderTaskRef = useRef<ReturnType<typeof pdfPageProxy.render> | null>(
		null,
	);

	const updateDetailCanvas = useCallback(() => {
		const scrollContainer = viewportRef?.current;
		if (!scrollContainer) return;

		const detailCanvas = ensureDetailCanvas();
		const container = containerRef.current;
		if (!detailCanvas || !container) return;

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

		const targetDetailScale = dpr * zoom * 1.3;
		const baseTargetScale = dpr * Math.min(zoom, 1);
		const baseScale = clampScaleForPage(baseTargetScale, pageWidth, pageHeight);
		const needsDetail = zoom > 1 && targetDetailScale - baseScale > 1e-3;

		if (!needsDetail) {
			detailCanvas.style.display = "none";
			detailCanvas.width = 0;
			detailCanvas.height = 0;
			return;
		}

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

		if (visibleWidth <= 0 || visibleHeight <= 0) {
			detailCanvas.style.display = "none";
			detailCanvas.width = 0;
			detailCanvas.height = 0;
			return;
		}

		detailCanvas.style.display = "block";

		const pdfOffsetX = visibleLeft;
		const pdfOffsetY = visibleTop;

		const effectiveScale = targetDetailScale;
		const actualWidth = visibleWidth * effectiveScale;
		const actualHeight = visibleHeight * effectiveScale;

		detailCanvas.width = actualWidth;
		detailCanvas.height = actualHeight;

		detailCanvas.style.width = `${visibleWidth * zoom}px`;
		detailCanvas.style.height = `${visibleHeight * zoom}px`;

		detailCanvas.style.transformOrigin = "center center";
		detailCanvas.style.transform = `translate(${visibleLeft * zoom}px, ${visibleTop * zoom}px) `;
		container.style.transform = `scale3d(${1 / zoom}, ${1 / zoom}, 1)`;
		container.style.transformOrigin = `0 0`;

		const context = detailCanvas.getContext("2d");
		if (!context) return;

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, detailCanvas.width, detailCanvas.height);

		if (renderTaskRef.current) {
			void renderTaskRef.current.cancel();
		}

		const detailViewport = pdfPageProxy.getViewport({ scale: effectiveScale });
		renderTaskRef.current = pdfPageProxy.render({
			canvasContext: context,
			viewport: detailViewport,
			background,
			transform: [1, 0, 0, 1, -pdfOffsetX * effectiveScale, -pdfOffsetY * effectiveScale],
		});

		renderTaskRef.current.promise.catch((error) => {
			if (error.name === "RenderingCancelledException") return;
			throw error;
		});
	}, [
		pdfPageProxy,
		zoom,
		background,
		dpr,
		viewportRef,
		ensureDetailCanvas,
		clampScaleForPage,
		baseCanvasRef,
	]);

	// Set up scroll-driven detail canvas updates outside React's render cycle.
	// Only active when zoom > 1, completely skipped at zoom <= 1.
	useLayoutEffect(() => {
		const scrollContainer = viewportRef?.current;
		if (!scrollContainer || zoom <= 1) {
			const detailCanvas = detailCanvasRef.current;
			if (detailCanvas) {
				detailCanvas.style.display = "none";
				detailCanvas.width = 0;
				detailCanvas.height = 0;
			}
			return;
		}

		updateDetailCanvas();

		let debounceTimer: ReturnType<typeof setTimeout>;
		const handleScroll = () => {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = requestAnimationFrame(updateDetailCanvas);
			}, 20);
		};

		scrollContainer.addEventListener("scroll", handleScroll, {
			passive: true,
		});

		return () => {
			scrollContainer.removeEventListener("scroll", handleScroll);
			clearTimeout(debounceTimer);
			cancelAnimationFrame(rafRef.current);
			if (renderTaskRef.current) {
				void renderTaskRef.current.cancel();
				renderTaskRef.current = null;
			}
		};
	}, [zoom, viewportRef, updateDetailCanvas]);

	return {
		detailCanvasRef,
		containerRef,
	};
};
