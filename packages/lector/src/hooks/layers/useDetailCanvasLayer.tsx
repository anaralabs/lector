import type { RenderTask } from "pdfjs-dist";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { subscribeToViewportInvalidation } from "../../lib/viewport-invalidation";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const MAX_CANVAS_PIXELS = 16777216;
const MAX_CANVAS_DIMENSION = 32767;
const DETAIL_RENDER_IDLE_MS = 80;

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
	const isPinching = usePdf((state) => state.isPinching);
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const viewportRef = usePdf((state) => state.viewportRef);

	const [zoom] = useDebounce(bouncyZoom, 200);

	const getDetailCanvas = useCallback(() => {
		const detailCanvas = detailCanvasRef.current;
		if (!detailCanvas) {
			return null;
		}

		detailCanvas.style.position = "absolute";
		detailCanvas.style.top = "0";
		detailCanvas.style.left = "0";
		detailCanvas.style.pointerEvents = "none";
		detailCanvas.style.zIndex = "1";
		detailCanvas.style.backgroundColor = background ?? "white";

		return detailCanvas;
	}, [background]);

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

	useLayoutEffect(() => {
		const scrollContainer = viewportRef?.current;
		if (!scrollContainer) {
			return;
		}

		const detailCanvas = getDetailCanvas();
		const container = containerRef.current;
		if (!detailCanvas || !container) {
			return;
		}

		let renderingTask: RenderTask | null = null;
		let renderTimeoutId: NodeJS.Timeout | null = null;

		const hideDetailCanvas = () => {
			renderingTask?.cancel();
			detailCanvas.style.display = "block";
			detailCanvas.style.opacity = "0";
			container.style.transform = "";
			container.style.transformOrigin = "";
		};

		const renderDetailCanvas = () => {
			const pageContainer = baseCanvasRef.current?.parentElement ?? null;
			if (!pageContainer) {
				hideDetailCanvas();
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
			const baseScale = clampScaleForPage(
				baseTargetScale,
				pageWidth,
				pageHeight,
			);
			const needsDetail = zoom > 1 && targetDetailScale - baseScale > 1e-3;

			if (
				isPinching ||
				!needsDetail ||
				visibleWidth <= 0 ||
				visibleHeight <= 0
			) {
				hideDetailCanvas();
				return;
			}

			renderingTask?.cancel();

			detailCanvas.style.display = "block";
			detailCanvas.style.opacity = "0";

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
			detailCanvas.style.transform = `translate(${visibleLeft * zoom}px, ${
				visibleTop * zoom
			}px)`;
			container.style.transform = `scale3d(${1 / zoom}, ${1 / zoom}, 1)`;
			container.style.transformOrigin = "0 0";

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
			const detailViewport = pdfPageProxy.getViewport({
				scale: effectiveScale,
			});

			const currentRenderingTask = pdfPageProxy.render({
				canvasContext: context,
				viewport: detailViewport,
				background,
				transform,
			});
			renderingTask = currentRenderingTask;

			currentRenderingTask.promise
				.then(() => {
					if (renderingTask === currentRenderingTask) {
						detailCanvas.style.opacity = "1";
					}
				})
				.catch((error) => {
					if (error.name === "RenderingCancelledException") {
						return;
					}

					throw error;
				})
				.finally(() => {
					if (renderingTask === currentRenderingTask) {
						renderingTask = null;
					}
				});
		};

		const scheduleRender = (delay = DETAIL_RENDER_IDLE_MS) => {
			if (renderTimeoutId !== null) {
				clearTimeout(renderTimeoutId);
			}

			hideDetailCanvas();

			renderTimeoutId = setTimeout(() => {
				renderTimeoutId = null;
				renderDetailCanvas();
			}, delay);
		};

		const unsubscribe = subscribeToViewportInvalidation(
			scrollContainer,
			scheduleRender,
		);

		scheduleRender(isPinching ? DETAIL_RENDER_IDLE_MS * 2 : 0);

		return () => {
			unsubscribe();

			if (renderTimeoutId !== null) {
				clearTimeout(renderTimeoutId);
			}

			void renderingTask?.cancel();
		};
	}, [
		pdfPageProxy,
		zoom,
		isPinching,
		background,
		dpr,
		viewportRef,
		getDetailCanvas,
		clampScaleForPage,
		baseCanvasRef,
	]);

	return {
		detailCanvasRef,
		containerRef,
	};
};
