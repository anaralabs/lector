export const MAX_CANVAS_PIXELS = 16777216;
export const MAX_CANVAS_DIMENSION = 32767;

// Canvases render supersampled by this factor and are downscaled at
// composite time. Empirically (Laplacian edge energy on identical retina
// screenshots, WebKit and Chromium): pdf.js content rasterized at 1.3x and
// bilinear-downscaled carries ~25% MORE edge energy than an exact 1:1
// render — the downscale steepens the antialiasing ramps, which users
// read as "crisp". Exact 1:1 is NOT the perceptual gold standard for
// pdf.js output; this matches the long-standing detail-overlay behavior.
export const CANVAS_SUPERSAMPLE = 1.3;

// pdf.js-style platform detection: actual mobile devices only. Generic
// touch-screen Windows/ChromeOS laptops report maxTouchPoints > 1 too, so
// the touch heuristic is scoped to iPads pretending to be MacIntel.
export const IS_MOBILE_DEVICE =
	typeof navigator !== "undefined" &&
	(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

// pdf.js-style adaptive pixel budget (capCanvasAreaFactor): a canvas never
// usefully holds more than a few times the screen's device-pixel area, so on
// small screens (phones, tablets) the budget shrinks well below
// MAX_CANVAS_PIXELS instead of letting every device allocate up to the iOS
// area limit. Mobile gets a tighter factor: the budget bounds EACH canvas
// and several pages are mounted at once, all counting toward the page's
// jetsam memory limit.
const CANVAS_AREA_FACTOR = IS_MOBILE_DEVICE ? 1.5 : 3;

export function getCanvasPixelBudget(): number {
	if (typeof window === "undefined" || typeof screen === "undefined") {
		return MAX_CANVAS_PIXELS;
	}
	const dpr = window.devicePixelRatio || 1;
	const screenArea = (screen.width || 0) * (screen.height || 0) * dpr * dpr;
	if (!Number.isFinite(screenArea) || screenArea <= 0) {
		return MAX_CANVAS_PIXELS;
	}
	return Math.min(MAX_CANVAS_PIXELS, screenArea * CANVAS_AREA_FACTOR);
}

export function clampScaleForPage(
	targetScale: number,
	pageWidth: number,
	pageHeight: number,
	maxPixels: number = MAX_CANVAS_PIXELS,
): number {
	if (!targetScale) {
		return 0;
	}

	const areaLimit = Math.sqrt(maxPixels / Math.max(pageWidth * pageHeight, 1));
	const widthLimit = MAX_CANVAS_DIMENSION / Math.max(pageWidth, 1);
	const heightLimit = MAX_CANVAS_DIMENSION / Math.max(pageHeight, 1);

	const safeScale = Math.min(
		targetScale,
		Number.isFinite(areaLimit) ? areaLimit : targetScale,
		Number.isFinite(widthLimit) ? widthLimit : targetScale,
		Number.isFinite(heightLimit) ? heightLimit : targetScale,
	);

	return Math.max(safeScale, 0);
}

// The base canvas renders at dpr * zoom * CANVAS_SUPERSAMPLE (not
// dpr * min(zoom, 1)) so pages stay sharp while scrolling at moderate
// zooms; the detail overlay is only needed once the budget clamp binds.
//
// Derived from the EXACT zoom — deliberately not quantized to zoom steps:
// quantization made the supersample factor vary per zoom (inconsistent
// softness across zoom levels). The bitmap cache absorbs the per-zoom
// variants via its byte budget and per-page variant cap.
export function computeBaseScale(
	dpr: number,
	zoom: number,
	pageWidth: number,
	pageHeight: number,
): number {
	return clampScaleForPage(
		dpr * Math.max(zoom, 0.1) * CANVAS_SUPERSAMPLE,
		pageWidth,
		pageHeight,
		getCanvasPixelBudget(),
	);
}
