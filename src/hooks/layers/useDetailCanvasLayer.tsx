import type { RenderTask } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { clampScaleForPage } from "../../lib/canvas-utils";
import { subscribeToViewportInvalidation } from "../../lib/viewport-invalidation";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

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

	useLayoutEffect(() => {
		const scrollContainer = viewportRef?.current;
		if (!scrollContainer) {
			return;
		}

		const detailCanvas = detailCanvasRef.current;
		const container = containerRef.current;
		if (!detailCanvas || !container) {
			return;
		}

		let renderingTask: RenderTask | null = null;
		let renderTimeoutId: NodeJS.Timeout | null = null;

		const bgColor = background ?? "white";
		const detailBaseStyle = `position:absolute;top:0;left:0;pointer-events:none;z-index:1;background-color:${bgColor}`;

		const hideDetailCanvas = () => {
			renderingTask?.cancel();
			detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:0`;
			container.style.cssText = "";
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

			const pdfOffsetX = visibleLeft;
			const pdfOffsetY = visibleTop;
			const effectiveScale = targetDetailScale;
			const actualWidth = visibleWidth * effectiveScale;
			const actualHeight = visibleHeight * effectiveScale;

			// Double-buffer: render to an offscreen buffer so the old detail
			// canvas stays visible during the render (no flash to pixelated base)
			const buffer = document.createElement("canvas");
			buffer.width = actualWidth;
			buffer.height = actualHeight;

			const bufferCtx = buffer.getContext("2d");
			if (!bufferCtx) {
				return;
			}

			bufferCtx.setTransform(1, 0, 0, 1, 0, 0);

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
				canvas: buffer,
				canvasContext: bufferCtx,
				viewport: detailViewport,
				background,
				transform,
			});
			renderingTask = currentRenderingTask;

			currentRenderingTask.promise
				.then(() => {
					if (renderingTask !== currentRenderingTask) return;

					// Swap: update the visible detail canvas in one go
					detailCanvas.width = actualWidth;
					detailCanvas.height = actualHeight;
					detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:1;width:${visibleWidth * zoom}px;height:${visibleHeight * zoom}px;transform-origin:center center;transform:translate(${visibleLeft * zoom}px,${visibleTop * zoom}px)`;
					container.style.cssText = `transform:scale3d(${1 / zoom},${1 / zoom},1);transform-origin:0 0`;

					const ctx = detailCanvas.getContext("2d");
					if (ctx) {
						ctx.drawImage(buffer, 0, 0);
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
					// Always release buffer — cancellations and stale tasks leak otherwise
					buffer.width = 0;
					buffer.height = 0;
				});
		};

		const scheduleRender = (delay = DETAIL_RENDER_IDLE_MS) => {
			if (renderTimeoutId !== null) {
				clearTimeout(renderTimeoutId);
			}

			// Cancel any in-progress render but keep the old detail canvas
			// visible — stale sharpness is better than a flash to pixelated base
			renderingTask?.cancel();

			renderTimeoutId = setTimeout(() => {
				renderTimeoutId = null;
				renderDetailCanvas();
			}, delay);
		};

		const unsubscribe = subscribeToViewportInvalidation(
			scrollContainer,
			scheduleRender,
		);

		if (zoom <= 1 || isPinching) {
			// Synchronously hide — runs before paint (useLayoutEffect),
			// so no stale rectangle flicker on zoom-out
			hideDetailCanvas();
		} else {
			scheduleRender(0);
		}

		return () => {
			unsubscribe();

			if (renderTimeoutId !== null) {
				clearTimeout(renderTimeoutId);
			}

			void renderingTask?.cancel();
			// Don't destroy canvas content — stale detail is better than a
			// white flash. The next effect run will hide or replace it.
		};
	}, [
		pdfPageProxy,
		zoom,
		isPinching,
		background,
		dpr,
		viewportRef,
		baseCanvasRef,
	]);

	// Release canvas memory for Safari on unmount only.
	// Capture ref into local var — React clears refs before passive cleanup runs.
	useEffect(() => {
		const canvas = detailCanvasRef.current;
		return () => {
			if (canvas) {
				canvas.width = 1;
				canvas.height = 1;
			}
		};
	}, []);

	return {
		detailCanvasRef,
		containerRef,
	};
};
