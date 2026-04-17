import type { RenderTask } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { clampScaleForPage } from "../../lib/canvas-utils";
import { msSinceScroll } from "../../lib/scroll-activity";
import { subscribeToViewportInvalidation } from "../../lib/viewport-invalidation";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const DETAIL_RENDER_IDLE_MS = 80;
const SCROLL_IDLE_MS = 120;

// Feature check once at module scope.
const supportsOffscreenCanvas =
	typeof OffscreenCanvas !== "undefined" &&
	(() => {
		try {
			const off = new OffscreenCanvas(1, 1);
			return !!off.getContext("2d");
		} catch {
			return false;
		}
	})();
const supportsBitmapRenderer =
	typeof document !== "undefined" &&
	(() => {
		try {
			const c = document.createElement("canvas");
			return !!c.getContext("bitmaprenderer");
		} catch {
			return false;
		}
	})();
const supportsGpuDetailHandoff =
	supportsOffscreenCanvas && supportsBitmapRenderer;

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
	const currentPage = usePdf((state) => state.currentPage);

	const [zoom] = useDebounce(bouncyZoom, 200);

	// Cache base viewport dimensions — they never change for a given page proxy.
	const pageDimsRef = useRef<{
		width: number;
		height: number;
		proxy: unknown;
	} | null>(null);
	if (!pageDimsRef.current || pageDimsRef.current.proxy !== pdfPageProxy) {
		const vp = pdfPageProxy.getViewport({ scale: 1 });
		pageDimsRef.current = {
			width: vp.width,
			height: vp.height,
			proxy: pdfPageProxy,
		};
	}

	// Once per canvas element, commit to a context type. `bitmaprenderer` and
	// `2d` are mutually exclusive: the first `getContext` call wins.
	const detailCtxRef = useRef<
		| { kind: "gpu"; ctx: ImageBitmapRenderingContext }
		| { kind: "2d"; ctx: CanvasRenderingContext2D }
		| null
	>(null);
	const getDetailCtx = () => {
		if (detailCtxRef.current) return detailCtxRef.current;
		const canvas = detailCanvasRef.current;
		if (!canvas) return null;
		if (supportsGpuDetailHandoff) {
			const ctx = canvas.getContext("bitmaprenderer");
			if (ctx) {
				detailCtxRef.current = { kind: "gpu", ctx };
				return detailCtxRef.current;
			}
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		detailCtxRef.current = { kind: "2d", ctx };
		return detailCtxRef.current;
	};

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

			const { width: pageWidth, height: pageHeight } = pageDimsRef.current!;

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

			const ctxHandle = getDetailCtx();
			if (!ctxHandle) return;

			if (ctxHandle.kind === "gpu") {
				// GPU sprinkle: render into OffscreenCanvas, transfer the
				// resulting bitmap into the display canvas via bitmaprenderer.
				// Zero-copy GPU handoff — replaces the previous buffer->drawImage
				// dance entirely.
				const off = new OffscreenCanvas(actualWidth, actualHeight);
				const offCtx = off.getContext("2d");
				if (!offCtx) return;
				offCtx.setTransform(1, 0, 0, 1, 0, 0);

				const currentRenderingTask = pdfPageProxy.render({
					// pdfjs accepts OffscreenCanvas at runtime even though the
					// types declare HTMLCanvasElement + CanvasRenderingContext2D.
					canvas: off as unknown as HTMLCanvasElement,
					canvasContext: offCtx as unknown as CanvasRenderingContext2D,
					viewport: detailViewport,
					background,
					transform,
				});
				renderingTask = currentRenderingTask;

				currentRenderingTask.promise
					.then(() => {
						if (renderingTask !== currentRenderingTask) return;
						const bitmap = off.transferToImageBitmap();
						detailCanvas.width = actualWidth;
						detailCanvas.height = actualHeight;
						detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:1;width:${visibleWidth * zoom}px;height:${visibleHeight * zoom}px;transform-origin:center center;transform:translate(${visibleLeft * zoom}px,${visibleTop * zoom}px)`;
						container.style.cssText = `transform:scale3d(${1 / zoom},${1 / zoom},1);transform-origin:0 0`;
						ctxHandle.ctx.transferFromImageBitmap(bitmap);
					})
					.catch((error) => {
						if (error.name === "RenderingCancelledException") return;
						throw error;
					})
					.finally(() => {
						if (renderingTask === currentRenderingTask) {
							renderingTask = null;
						}
					});
				return;
			}

			// 2D fallback — keep the original double-buffered flow for older
			// browsers that don't support OffscreenCanvas + bitmaprenderer.
			const buffer = document.createElement("canvas");
			buffer.width = actualWidth;
			buffer.height = actualHeight;

			const bufferCtx = buffer.getContext("2d");
			if (!bufferCtx) return;
			bufferCtx.setTransform(1, 0, 0, 1, 0, 0);

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
					detailCanvas.width = actualWidth;
					detailCanvas.height = actualHeight;
					detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:1;width:${visibleWidth * zoom}px;height:${visibleHeight * zoom}px;transform-origin:center center;transform:translate(${visibleLeft * zoom}px,${visibleTop * zoom}px)`;
					container.style.cssText = `transform:scale3d(${1 / zoom},${1 / zoom},1);transform-origin:0 0`;
					ctxHandle.ctx.drawImage(buffer, 0, 0);
				})
				.catch((error) => {
					if (error.name === "RenderingCancelledException") return;
					throw error;
				})
				.finally(() => {
					if (renderingTask === currentRenderingTask) {
						renderingTask = null;
					}
					buffer.width = 0;
					buffer.height = 0;
				});
		};

		// After any debounce delay, also wait for the scroll itself to be
		// quiet. A 120 ms scroll-idle gate keeps the heavy detail pdfjs
		// render (3-10x more expensive than the base render at zoom > 1)
		// off the main thread while the user is still flicking.
		const attemptRender = () => {
			const sinceScroll = msSinceScroll();
			if (sinceScroll < SCROLL_IDLE_MS) {
				renderTimeoutId = setTimeout(
					attemptRender,
					SCROLL_IDLE_MS - sinceScroll,
				);
				return;
			}
			renderTimeoutId = null;
			renderDetailCanvas();
		};

		const scheduleRender = (delay = DETAIL_RENDER_IDLE_MS) => {
			if (renderTimeoutId !== null) {
				clearTimeout(renderTimeoutId);
			}
			renderingTask?.cancel();
			renderTimeoutId = setTimeout(attemptRender, delay);
		};

		// Only subscribe to scroll/resize invalidation when the detail canvas
		// actually has work to do. At zoom <= 1 the renderer immediately
		// short-circuits via `needsDetail`, so subscribing just wastes a rAF
		// per page per scroll event.
		const needsInvalidationSubscription = zoom > 1 && !isPinching;
		const unsubscribe = needsInvalidationSubscription
			? subscribeToViewportInvalidation(scrollContainer, scheduleRender)
			: null;

		if (zoom <= 1 || isPinching) {
			hideDetailCanvas();
		} else {
			// Stagger the initial post-zoom render by distance from the
			// current page so a zoom-in with 5 visible pages doesn't fire
			// 5 detail renders on the same frame.
			const distance = Math.abs(pageNumber - (currentPage || pageNumber));
			const staggerDelay =
				distance <= 1 ? 0 : Math.min(distance * 30, 200);
			scheduleRender(staggerDelay);
		}

		return () => {
			unsubscribe?.();

			if (renderTimeoutId !== null) {
				clearTimeout(renderTimeoutId);
			}

			void renderingTask?.cancel();
		};
		// `currentPage` is intentionally excluded from deps: it only seeds
		// the initial stagger delay. Letting it re-run this effect on
		// every scrolled-past page would cancel in-flight detail renders
		// and cause thrashing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		pdfPageProxy,
		zoom,
		isPinching,
		background,
		dpr,
		viewportRef,
		baseCanvasRef,
	]);

	useEffect(() => {
		const canvas = detailCanvasRef.current;
		return () => {
			if (canvas) {
				canvas.width = 1;
				canvas.height = 1;
			}
			detailCtxRef.current = null;
		};
	}, []);

	return {
		detailCanvasRef,
		containerRef,
	};
};
