// Scan-paper verdict for one image (ported from @anaralabs/lector's scan-invert policy).
const WHITE_MIN_FRACTION = 0.6;
const OPAQUE_MIN_FRACTION = 0.99;
const SATURATED_MAX_FRACTION = 0.15;
const SAMPLE_PX = 64;
const INK_MAX = 100;
/** margin left out of sampling: rendered images carry antialiased edges and deskew wedges there */
const EDGE_MIN_PX = 4;
const EDGE_FRACTION = 0.03;

/** A decoded bitmap: rows of `stride` bytes from `offset`, gray (1) or BGR(x/A) (3, 4) pixels. */
export interface BitmapView {
	data: Uint8Array;
	offset: number;
	width: number;
	height: number;
	stride: number;
	bpp: 1 | 3 | 4;
	alpha: boolean;
}

/**
 * Null when the image is not paper (photo, colourful, cut-out), else whether it
 * carries dark ink. Colour and coverage come from a block-averaged ~64px grid;
 * ink from each block's darkest sample, since thin text strokes average out to grey.
 */
export function paperVerdict(b: BitmapView): { inked: boolean } | null {
	const { data, offset, stride, bpp, alpha } = b;
	if (b.width <= 0 || b.height <= 0) return null;
	const ix = inset(b.width);
	const iy = inset(b.height);
	const w = b.width - 2 * ix;
	const h = b.height - 2 * iy;
	if (w <= 0 || h <= 0) return null;
	const scale = Math.min(1, SAMPLE_PX / Math.max(w, h));
	const gw = Math.max(1, Math.round(w * scale));
	const gh = Math.max(1, Math.round(h * scale));
	// Block sums: r, g, b, alpha, count
	const acc = new Float64Array(gw * gh * 5);
	const darkest = new Uint8Array(gw * gh).fill(255);
	// Reading every pixel of a big rendered image is wasteful: step so each block gets ~16x16 reads.
	const step = Math.max(1, Math.floor(Math.max(w / gw, h / gh) / 16));
	for (let y = 0; y < h; y += step) {
		const by = Math.min(gh - 1, Math.floor(y * scale));
		const row = offset + (iy + y) * stride;
		for (let x = 0; x < w; x += step) {
			const block = by * gw + Math.min(gw - 1, Math.floor(x * scale));
			const o = row + (ix + x) * bpp;
			const k = block * 5;
			const r = bpp === 1 ? data[o]! : data[o + 2]!;
			const g = bpp === 1 ? r : data[o + 1]!;
			const bl = bpp === 1 ? r : data[o]!;
			const al = alpha && bpp === 4 ? data[o + 3]! : 255;
			acc[k] += r;
			acc[k + 1] += g;
			acc[k + 2] += bl;
			acc[k + 3] += al;
			acc[k + 4]++;
			const max = Math.max(r, g, bl);
			if (al >= 250 && max < darkest[block]!) darkest[block] = max;
		}
	}
	const total = gw * gh;
	let white = 0;
	let opaque = 0;
	let saturated = 0;
	let ink = 0;
	for (let block = 0; block < total; block++) {
		const k = block * 5;
		const n = acc[k + 4]!;
		if (!n || acc[k + 3]! / n < 250) continue;
		opaque++;
		const r = acc[k]! / n;
		const g = acc[k + 1]! / n;
		const bl = acc[k + 2]! / n;
		const max = Math.max(r, g, bl);
		const min = Math.min(r, g, bl);
		if (min > 200 && max - min < 32) white++;
		else if (max > 60 && (max - min) / max > 0.35) saturated++;
		if (darkest[block]! < INK_MAX) ink++;
	}
	const paper =
		opaque / total >= OPAQUE_MIN_FRACTION &&
		white / total >= WHITE_MIN_FRACTION &&
		saturated / total <= SATURATED_MAX_FRACTION;
	return paper ? { inked: ink >= 1 } : null;
}

function inset(n: number) {
	return Math.min(
		Math.floor((n - 1) / 2),
		Math.max(EDGE_MIN_PX, Math.ceil(n * EDGE_FRACTION)),
	);
}
