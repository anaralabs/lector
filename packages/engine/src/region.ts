// Region maths for the page renderer, kept free of I/O so tests run them in Node.

import type { PageSize } from "./protocol";

/** A rectangle in page points, top-left origin. */
export interface Region {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** the largest side a rendered region may have, in device pixels */
export const MAX_REGION_SIDE = 4096;

/**
 * Where `region` (the whole page when omitted) lands when rendered `width`
 * device pixels wide: clamped to the page, the scale in device pixels per
 * point, and the pixel box to ask a raster worker for. Never larger than
 * `maxSide` on either side.
 */
export function regionRaster(page: PageSize, region: Region | undefined, width: number, maxSide = MAX_REGION_SIDE) {
	const x0 = Math.min(page.w, Math.max(0, region?.x ?? 0));
	const y0 = Math.min(page.h, Math.max(0, region?.y ?? 0));
	const x1 = Math.min(page.w, Math.max(x0, region ? region.x + region.w : page.w));
	const y1 = Math.min(page.h, Math.max(y0, region ? region.y + region.h : page.h));
	const rect: Region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	if (!(rect.w > 0 && rect.h > 0) || !(width > 0)) return null;
	let scale = Math.min(width, maxSide) / rect.w;
	if (rect.h * scale > maxSide) scale = maxSide / rect.h;
	const px = Math.round(x0 * scale);
	const py = Math.round(y0 * scale);
	return {
		rect,
		scale,
		x: px,
		y: py,
		w: Math.max(1, Math.round(x1 * scale) - px),
		h: Math.max(1, Math.round(y1 * scale) - py),
	};
}
