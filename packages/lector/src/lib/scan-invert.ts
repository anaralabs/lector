/**
 * Scanned pages keep their white raster pixels under the dark-scheme recolor:
 * the color map only touches vector fills/strokes, never image data. The
 * policy here decides which image draws are scan paper — painted large enough
 * to cover the page AND dominated by near-white pixels — so the recolor layer
 * can invert them toward the palette poles. Photos, embedded figures and
 * colorful scans (color certificates, palette sheets) never qualify.
 */

/** Painted area relative to the page above which a draw "papers the page". */
export const SCAN_COVERAGE_MIN = 0.7;
/** Fraction of near-white opaque pixels above which a source is scan paper. */
export const SCAN_WHITE_MIN_FRACTION = 0.6;

const SAMPLE_TARGET_PX = 48;

// ImageBitmaps are immutable — one verdict per bitmap. Canvas sources get
// repainted (pdf.js reuses scratch canvases), so they are re-sampled per draw.
const bitmapVerdicts = new WeakMap<ImageBitmap, boolean>();

export function sourceSize(
	source: CanvasImageSource,
): { width: number; height: number } | null {
	if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
		return { width: source.width, height: source.height };
	}
	if (
		typeof HTMLCanvasElement !== "undefined" &&
		source instanceof HTMLCanvasElement
	) {
		return { width: source.width, height: source.height };
	}
	if (
		typeof OffscreenCanvas !== "undefined" &&
		source instanceof OffscreenCanvas
	) {
		return { width: source.width, height: source.height };
	}
	if (
		typeof HTMLImageElement !== "undefined" &&
		source instanceof HTMLImageElement
	) {
		return { width: source.naturalWidth, height: source.naturalHeight };
	}
	return null;
}

function sampleWhiteFraction(
	source: CanvasImageSource,
	width: number,
	height: number,
): number | null {
	if (typeof document === "undefined") return null;
	const scale = Math.min(1, SAMPLE_TARGET_PX / Math.max(width, height));
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));
	const tmp = document.createElement("canvas");
	tmp.width = w;
	tmp.height = h;
	const ctx = tmp.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	try {
		ctx.drawImage(source, 0, 0, w, h);
		const { data } = ctx.getImageData(0, 0, w, h);
		let white = 0;
		for (let i = 0; i < data.length; i += 4) {
			const max = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
			const min = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
			// Transparent pixels count against: image masks and cut-out art
			// are not paper, and inverting them would fill their holes.
			if (data[i + 3]! > 200 && min > 200 && max - min < 32) white++;
		}
		return white / (data.length / 4);
	} catch {
		// Tainted or detached sources never qualify.
		return null;
	}
}

export function isScanPaperSource(source: CanvasImageSource): boolean {
	const bitmap =
		typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap
			? source
			: null;
	if (bitmap) {
		const cached = bitmapVerdicts.get(bitmap);
		if (cached !== undefined) return cached;
	}
	const size = sourceSize(source);
	const fraction =
		size && size.width > 0 && size.height > 0
			? sampleWhiteFraction(source, size.width, size.height)
			: null;
	const verdict = fraction !== null && fraction >= SCAN_WHITE_MIN_FRACTION;
	if (bitmap) bitmapVerdicts.set(bitmap, verdict);
	return verdict;
}
