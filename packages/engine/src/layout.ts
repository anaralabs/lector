// Page layout with sizes that may still be unknown (range loading reads them
// lazily), and the camera correction that keeps the page in view still when an
// estimated size resolves. No runtime imports: tests load this file in Node.

export interface Size {
	w: number;
	h: number;
}

export interface PageRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Sizes for every page: known ones as given, unknown ones as the nearest known page before (or after) them. */
export function estimateSizes(known: (Size | null | undefined)[]): { sizes: Size[]; estimated: boolean[] } {
	const n = known.length;
	const sizes: Size[] = new Array(n);
	const estimated: boolean[] = new Array(n);
	let fallback: Size | null = null;
	for (let i = 0; i < n; i++) {
		const k = known[i];
		if (k) {
			fallback = k;
			break;
		}
	}
	fallback ??= { w: 612, h: 792 };
	let last = fallback;
	for (let i = 0; i < n; i++) {
		const k = known[i];
		if (k) last = k;
		sizes[i] = k ?? last;
		estimated[i] = !k;
	}
	return { sizes, estimated };
}

export function buildLayout(sizes: Size[], gap: number): { rects: PageRect[]; docW: number; docH: number } {
	let y = gap;
	let docW = 0;
	const rects = sizes.map((p) => {
		const r = { x: -p.w / 2, y, w: p.w, h: p.h };
		y += p.h + gap;
		docW = Math.max(docW, p.w);
		return r;
	});
	return { rects, docW, docH: y };
}

export function pageAt(rects: PageRect[], y: number): number {
	let lo = 0;
	let hi = rects.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (rects[mid]!.y <= y) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * The camera y (doc points at the viewport top) that shows the same content
 * after a relayout: the doc point at the viewport's vertical centre stays at
 * the same place within its page (or in the gap after it).
 */
export function anchoredY(before: PageRect[], after: PageRect[], camY: number, viewH: number): number {
	if (!before.length || before.length !== after.length) return camY;
	const cy = camY + viewH / 2;
	const p = pageAt(before, cy);
	const a = before[p]!;
	const b = after[p]!;
	const within = cy - a.y;
	// Inside the page: same fraction of it. Below it (the gap): same distance.
	const ny = within <= a.h && a.h > 0 ? b.y + (within / a.h) * b.h : b.y + b.h + (within - a.h);
	return ny - viewH / 2;
}
