import type { RenderTask } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { PDFStore, usePdf } from "../../internal";
import {
	clampScaleForPage,
	computeBaseScale,
	computeTargetScale,
	getCanvasPixelBudget,
	MAX_CANVAS_DIMENSION,
} from "../../lib/canvas-utils";
import { createDarkModeColorMap } from "../../lib/dark-mode";
import { applyContextRecolor } from "../../lib/recolor-context";
import { subscribeToViewportInvalidation } from "../../lib/viewport-invalidation";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const DETAIL_RENDER_IDLE_MS = 80;
const SCROLL_POLL_MS = 160;
const ZOOM_DEBOUNCE_MS = 200;
// Must exceed ZOOM_DEBOUNCE_MS plus one rAF of store-push latency: a render
// that passes the settle gate is then guaranteed to hold the settled
// (debounced) zoom in its closure, never a stale one — otherwise it would
// compute a wrong-region rect. The live-zoom re-check in renderDetailCanvas
// backstops this invariant anyway.
const ZOOM_SETTLE_MS = ZOOM_DEBOUNCE_MS + 50;
// Overscan around the visible rect, as a fraction of the viewport per side,
// so normal scrolling stays inside the sharp region instead of revealing the
// upscaled base canvas. Vertical gets more because documents mostly scroll
// vertically. The actual padding shrinks to fit the pixel budget.
const OVERSCAN_X = 0.25;
const OVERSCAN_Y = 0.5;
// A hidden overlay keeps its last frame briefly (re-showing beats a flash),
// then releases its backing store — Safari counts it against page memory.
const RELEASE_HIDDEN_MS = 2000;

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
	const store = PDFStore.useContext();

	const bouncyZoom = usePdf((state) => state.zoom);
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const viewportRef = usePdf((state) => state.viewportRef);
	const colorScheme = usePdf((state) => state.colorScheme);
	const darkModeColors = usePdf((state) => state.darkModeColors);

	// Memoized per palette — stable identity, safe as an effect dependency.
	const recolor =
		colorScheme === "dark" ? createDarkModeColorMap(darkModeColors) : null;
	const recolorKey = recolor
		? `dark:${darkModeColors.background},${darkModeColors.foreground}`
		: "light";

	// What the visible overlay currently shows: page proxy, content key,
	// render scale and the covered page-space rect — or null when the overlay
	// is hidden. The proxy guards against a recycled component (e.g. a
	// standalone <Page> whose pageNumber prop changes) keeping another page's
	// pixels on screen.
	const paintedRef = useRef<{
		proxy: unknown;
		key: string;
		scale: number;
		left: number;
		top: number;
		width: number;
		height: number;
	} | null>(null);
	const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const [zoom] = useDebounce(bouncyZoom, ZOOM_DEBOUNCE_MS);

	// Track when the live zoom last changed so the render can wait out a
	// multi-segment gesture (wheel pulses end the use-gesture pinch between
	// segments, so `isPinching` alone lets a 100ms+ detail render fire
	// mid-gesture).
	// Seed so an idle mount renders immediately, but a layer mounting during
	// an active pinch waits out the settle window.
	const lastZoomChangeRef = useRef(
		store.getState().isPinching ? performance.now() : 0,
	);
	const prevBouncyZoomRef = useRef(bouncyZoom);
	if (prevBouncyZoomRef.current !== bouncyZoom) {
		prevBouncyZoomRef.current = bouncyZoom;
		lastZoomChangeRef.current = performance.now();
	}

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

		const contentKey = `${background ?? "white"}|${recolorKey}`;
		// No CSS background: if a backing-store allocation ever fails (Safari
		// limits), the overlay must degrade to showing the blurry base through
		// it, not cover the page with an opaque blank rectangle.
		const detailBaseStyle =
			"position:absolute;top:0;left:0;pointer-events:none;z-index:1";

		const hideDetailCanvas = () => {
			renderingTask?.cancel();
			// Null the task too: cancel() is a no-op on an internally-completed
			// task, and its pending swap must not re-show the overlay after a
			// hide — the swap's identity guard catches it once this is null.
			renderingTask = null;
			detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:0`;
			container.style.cssText = "";
			paintedRef.current = null;
			if (releaseTimerRef.current === null) {
				releaseTimerRef.current = setTimeout(() => {
					releaseTimerRef.current = null;
					detailCanvas.width = 1;
					detailCanvas.height = 1;
				}, RELEASE_HIDDEN_MS);
			}
		};

		// Populated during render (above) for the current proxy, so this is
		// provably non-null — but guard instead of asserting, so a future
		// reorder degrades to a hidden overlay rather than a throw.
		const pageDims = pageDimsRef.current;
		if (!pageDims) {
			hideDetailCanvas();
			return;
		}
		const { width: pageWidth, height: pageHeight } = pageDims;

		// Decide from cached page dims + zoom only — NO layout reads. The
		// detail pass is needed exactly when the base canvas could not reach
		// the full target output scale (its budget clamp bound), which the
		// shared helpers tell us directly. This also covers oversized pages
		// (posters, plans) clamped below device resolution at zoom <= 1.
		const targetDetailScale = computeTargetScale(dpr, zoom);
		const baseScale = computeBaseScale(dpr, zoom, pageWidth, pageHeight);
		const needsDetail = targetDetailScale - baseScale > 1e-3;

		const renderDetailCanvas = () => {
			// The viewport-invalidation subscription schedules renders on every
			// scroll/resize regardless of zoom — when the base canvas already
			// covers full output resolution there is nothing to sharpen and an
			// overlay would just duplicate it.
			// Recomputed live rather than trusting the effect-time value: the
			// pixel budget reads screen dimensions, which can change (monitor
			// move) without any effect dependency changing.
			if (
				targetDetailScale -
					computeBaseScale(dpr, zoom, pageWidth, pageHeight) <=
				1e-3
			) {
				hideDetailCanvas();
				return;
			}

			// Don't read layout (getBoundingClientRect below) while the user is
			// scrolling: the read forces a synchronous reflow of the whole page
			// tree (catastrophic with text layers present), and the detail
			// sharpening is invisible mid-scroll anyway. Poll until scroll settles.
			const virtualizer = store.getState().virtualizer;
			if (virtualizer?.isScrolling) {
				scheduleRender(SCROLL_POLL_MS);
				return;
			}

			// Likewise, don't render between segments of a zoom gesture (wheel
			// pulses, pinch pauses): the 100ms+ sharpening pass would land
			// mid-gesture and be thrown away by the next zoom change anyway.
			// Wait until the live zoom has been stable for a beat, polling just
			// past the settle deadline instead of on a fixed quantum.
			const settleElapsed = performance.now() - lastZoomChangeRef.current;
			if (store.getState().isPinching || settleElapsed < ZOOM_SETTLE_MS) {
				scheduleRender(Math.max(50, ZOOM_SETTLE_MS - settleElapsed + 10));
				return;
			}

			// The closure zoom is the debounced value; if the live zoom has
			// moved on, this closure would compute a wrong-region rect. The
			// settle gate above makes this unreachable today — this is the
			// guard that keeps it unreachable if the constants are ever tuned.
			if (store.getState().zoom !== zoom) {
				scheduleRender(ZOOM_SETTLE_MS);
				return;
			}

			const pageContainer = baseCanvasRef.current?.parentElement ?? null;
			if (!pageContainer) {
				hideDetailCanvas();
				return;
			}

			// Visible region of the page, in page units (scale-1 CSS px).
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
				hideDetailCanvas();
				return;
			}

			// The budget clamp keeps every allocation under the Safari area
			// limit even on huge viewports — degrade resolution, never blank.
			const budget = getCanvasPixelBudget();
			let effectiveScale = clampScaleForPage(
				targetDetailScale,
				visibleWidth,
				visibleHeight,
				budget,
			);

			// Overscan padding (page units per side). The rect can grow up to
			// this much past the visible region, so the per-dimension canvas
			// limit must be enforced against the padded bounds — and it must
			// happen BEFORE the covered-rect check so painted.scale compares
			// against the final scale (otherwise extreme aspect ratios would
			// re-render forever).
			const padX = OVERSCAN_X * viewportWidth;
			const padY = OVERSCAN_Y * viewportHeight;
			const maxRectWidth = Math.min(pageWidth, visibleWidth + 2 * padX);
			const maxRectHeight = Math.min(pageHeight, visibleHeight + 2 * padY);
			effectiveScale = Math.min(
				effectiveScale,
				MAX_CANVAS_DIMENSION / Math.max(maxRectWidth, 1),
				MAX_CANVAS_DIMENSION / Math.max(maxRectHeight, 1),
			);

			// Still sharp at the right scale and the visible region is inside
			// the painted (overscanned) rect — scrolling within the overscan
			// margin costs zero work. Tolerance is one device pixel (a fixed
			// page-unit epsilon would scale up to a visible soft seam at high
			// zoom).
			const eps = 1 / effectiveScale;
			const painted = paintedRef.current;
			if (
				painted &&
				painted.proxy === pdfPageProxy &&
				painted.key === contentKey &&
				painted.scale === effectiveScale &&
				visibleLeft >= painted.left - eps &&
				visibleTop >= painted.top - eps &&
				visibleRight <= painted.left + painted.width + eps &&
				visibleBottom <= painted.top + painted.height + eps
			) {
				// The view is already covered, so any in-flight render targets a
				// region the user scrolled away from — let it land and it would
				// MOVE the (single) overlay canvas off the current view. Cancel
				// it; nulling also blocks a resolved-but-unswapped task's swap.
				renderingTask?.cancel();
				renderingTask = null;
				return;
			}

			// Spend whatever pixel budget remains after the visible rect on
			// overscan, shrinking the padding factor f so that
			// (w + 2·padX·f)(h + 2·padY·f) <= maxArea.
			const maxArea = budget / (effectiveScale * effectiveScale);
			const a = 4 * padX * padY;
			const b = 2 * (visibleWidth * padY + visibleHeight * padX);
			const c = visibleWidth * visibleHeight - maxArea;
			let padFactor = 1;
			if (a > 0) {
				padFactor = Math.min(
					1,
					Math.max(
						0,
						(-b + Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a),
					),
				);
			} else if (b > 0) {
				padFactor = Math.min(1, Math.max(0, -c / b));
			}

			const rectLeft = Math.max(0, visibleLeft - padX * padFactor);
			const rectTop = Math.max(0, visibleTop - padY * padFactor);
			const rectRight = Math.min(pageWidth, visibleRight + padX * padFactor);
			const rectBottom = Math.min(pageHeight, visibleBottom + padY * padFactor);
			const rectWidth = rectRight - rectLeft;
			const rectHeight = rectBottom - rectTop;

			// A new render is starting — the in-flight one (if any) targets an
			// outdated rect, so replace it. And don't let a release timer from
			// an earlier hide shrink the canvas out from under this pass.
			renderingTask?.cancel();
			if (releaseTimerRef.current !== null) {
				clearTimeout(releaseTimerRef.current);
				releaseTimerRef.current = null;
			}

			const actualWidth = Math.max(1, Math.floor(rectWidth * effectiveScale));
			const actualHeight = Math.max(1, Math.floor(rectHeight * effectiveScale));

			// Double-buffer: render to an offscreen buffer so the old detail
			// canvas stays visible during the render (no flash to pixelated base)
			const buffer = document.createElement("canvas");
			buffer.width = actualWidth;
			buffer.height = actualHeight;

			const bufferCtx = buffer.getContext("2d");
			if (!bufferCtx) {
				buffer.width = 0;
				buffer.height = 0;
				// Canvas memory pressure: degrade to the base layer and release
				// our backing instead of keeping a stale, partially-covering
				// overlay. Release IMMEDIATELY rather than after the hide grace
				// period — freeing memory is exactly what the system needs when
				// an allocation just failed.
				hideDetailCanvas();
				if (releaseTimerRef.current !== null) {
					clearTimeout(releaseTimerRef.current);
					releaseTimerRef.current = null;
				}
				detailCanvas.width = 1;
				detailCanvas.height = 1;
				return;
			}

			bufferCtx.setTransform(1, 0, 0, 1, 0, 0);

			const transform = [
				1,
				0,
				0,
				1,
				-rectLeft * effectiveScale,
				-rectTop * effectiveScale,
			];
			const detailViewport = pdfPageProxy.getViewport({
				scale: effectiveScale,
			});

			// Native dark mode: recolor at draw time; `background` stays the
			// original color and is mapped by the wrapped fillRect exactly once.
			if (recolor) applyContextRecolor(bufferCtx, recolor);

			const releaseBuffer = () => {
				buffer.width = 0;
				buffer.height = 0;
			};

			let currentRenderingTask: RenderTask;
			try {
				currentRenderingTask = pdfPageProxy.render({
					canvas: buffer,
					canvasContext: bufferCtx,
					viewport: detailViewport,
					background,
					transform,
				});
			} catch (error) {
				releaseBuffer();
				throw error;
			}
			renderingTask = currentRenderingTask;

			// Derive the on-screen geometry from the floored backing size so the
			// backing-to-device-pixel ratio stays exact (1:1 at full resolution).
			const cssWidth = (actualWidth / effectiveScale) * zoom;
			const cssHeight = (actualHeight / effectiveScale) * zoom;

			currentRenderingTask.promise
				.then(() => {
					if (renderingTask !== currentRenderingTask) return;

					// Same guard as the base canvas: a render finishing inside the
					// scheme-toggle window (map already swapped, cleanup not yet
					// run) must not blit wrong/mixed-scheme pixels. The effect
					// re-run re-renders the detail region right after.
					const state = store.getState();
					const currentRecolorKey =
						state.colorScheme === "dark"
							? `dark:${state.darkModeColors.background},${state.darkModeColors.foreground}`
							: "light";
					if (currentRecolorKey !== recolorKey) return;

					// Swap: update the visible detail canvas in one go
					detailCanvas.width = actualWidth;
					detailCanvas.height = actualHeight;
					detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:1;width:${cssWidth}px;height:${cssHeight}px;transform-origin:center center;transform:translate(${rectLeft * zoom}px,${rectTop * zoom}px)`;
					container.style.cssText = `transform:scale3d(${1 / zoom},${1 / zoom},1);transform-origin:0 0`;

					const ctx = detailCanvas.getContext("2d");
					if (!ctx) {
						// "Painted" must be a postcondition of a successful blit:
						// recording it here would satisfy future covered-rect
						// checks and pin the blurry base on screen forever.
						hideDetailCanvas();
						return;
					}
					ctx.drawImage(buffer, 0, 0);
					paintedRef.current = {
						proxy: pdfPageProxy,
						key: contentKey,
						scale: effectiveScale,
						left: rectLeft,
						top: rectTop,
						// The truly painted extent comes from the floored backing,
						// not the requested rect.
						width: actualWidth / effectiveScale,
						height: actualHeight / effectiveScale,
					};
					if (releaseTimerRef.current !== null) {
						clearTimeout(releaseTimerRef.current);
						releaseTimerRef.current = null;
					}
					// Re-validate coverage: if the user scrolled elsewhere while
					// this render was in flight (the covered-rect check may have
					// skipped scheduling against the PREVIOUS painted rect), this
					// schedules a corrective render; when the landed rect still
					// covers the viewport it's a free no-op.
					scheduleRender();
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
					releaseBuffer();
				});
		};

		const scheduleRender = (delay = DETAIL_RENDER_IDLE_MS) => {
			if (renderTimeoutId !== null) {
				clearTimeout(renderTimeoutId);
			}

			// Deliberately do NOT cancel an in-flight render here: it blits at
			// page-anchored coordinates, so it stays correct after a scroll, and
			// a 90%-complete sharpening pass is worth keeping. It is replaced
			// only when a new render actually starts (rect went stale) or the
			// overlay hides.
			renderTimeoutId = setTimeout(() => {
				renderTimeoutId = null;
				renderDetailCanvas();
			}, delay);
		};

		const unsubscribe = subscribeToViewportInvalidation(
			scrollContainer,
			scheduleRender,
		);

		if (!needsDetail) {
			// Synchronously hide — runs before paint (useLayoutEffect),
			// so no stale rectangle flicker on zoom-out
			hideDetailCanvas();
		} else {
			// Stale detail is only better than a flash when it matches the
			// current scheme/background AND page. Across a theme toggle (or a
			// page-proxy swap on a recycled component) the old overlay would
			// show wrong pixels over a correct base — hide it before paint and
			// let the scheduled render bring sharpness back.
			if (
				paintedRef.current !== null &&
				(paintedRef.current.key !== contentKey ||
					paintedRef.current.proxy !== pdfPageProxy)
			) {
				hideDetailCanvas();
			}
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
		background,
		dpr,
		viewportRef,
		baseCanvasRef,
		store,
		recolor,
		recolorKey,
	]);

	// Release canvas memory for Safari on unmount only.
	// Capture ref into local var — React clears refs before passive cleanup runs.
	useEffect(() => {
		const canvas = detailCanvasRef.current;
		return () => {
			if (releaseTimerRef.current !== null) {
				clearTimeout(releaseTimerRef.current);
				releaseTimerRef.current = null;
			}
			if (canvas) {
				canvas.width = 1;
				canvas.height = 1;
			}
			// Keep the "paintedRef non-null implies the canvas holds that
			// frame" invariant — under StrictMode this cleanup runs on a
			// simulated unmount and the component lives on with the same refs.
			paintedRef.current = null;
		};
	}, []);

	return {
		detailCanvasRef,
		containerRef,
	};
};
