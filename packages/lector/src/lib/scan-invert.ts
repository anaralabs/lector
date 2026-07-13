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
/**
 * Minimum painted fraction for a draw to count as a scan tile: some raster
 * PDFs encode a page as strips/tiles whose areas only paper the page in sum.
 */
export const SCAN_TILE_MIN_FRACTION = 0.05;
/**
 * Minimum density (summed tile area / union bounding box area) for pending
 * tiles to read as one contiguous scan: strips partitioning a page are dense,
 * scattered white screenshots on a text page are not.
 */
export const SCAN_TILE_DENSITY_MIN = 0.85;
/** Fraction of near-white opaque pixels above which a source is scan paper. */
export const SCAN_WHITE_MIN_FRACTION = 0.6;
/**
 * Minimum fraction of dark "ink" pixels. A pure-white raster is an MRC
 * background layer (its ink lives in a separate dark layer that must stay
 * un-inverted to remain readable) or a blank page — skip both.
 */
export const SCAN_INK_MIN_FRACTION = 0.005;
/**
 * Minimum opaque fraction: scans are fully opaque; a cut-out PNG would let
 * the inversion fill bleed into its transparent holes.
 */
export const SCAN_OPAQUE_MIN_FRACTION = 0.99;
/**
 * Maximum saturated fraction. Stamps and seals on real scans measure a few
 * percent saturated; a rasterized slide with a colored chart measures far
 * more — inverting it would render the chart as a negative.
 */
export const SCAN_SATURATED_MAX_FRACTION = 0.15;

const SAMPLE_TARGET_PX = 48;

export interface SourceCrop {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
}

// ImageBitmaps are immutable — one whole-source verdict per bitmap. Canvas
// sources get repainted (pdf.js reuses scratch canvases) and cropped draws
// vary per call, so those are re-sampled per draw.
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

function isScanPaperSample(
	source: CanvasImageSource,
	crop: SourceCrop,
): boolean {
	if (typeof document === "undefined") return false;
	const scale = Math.min(1, SAMPLE_TARGET_PX / Math.max(crop.sw, crop.sh));
	const w = Math.max(1, Math.round(crop.sw * scale));
	const h = Math.max(1, Math.round(crop.sh * scale));
	const tmp = document.createElement("canvas");
	tmp.width = w;
	tmp.height = h;
	const ctx = tmp.getContext("2d", { willReadFrequently: true });
	if (!ctx) return false;
	try {
		ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
		const { data } = ctx.getImageData(0, 0, w, h);
		const total = data.length / 4;
		let white = 0;
		let opaque = 0;
		let saturated = 0;
		let ink = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i + 3]! < 250) continue;
			opaque++;
			const max = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
			const min = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
			if (min > 200 && max - min < 32) white++;
			else if (max > 60 && (max - min) / max > 0.35) saturated++;
			if (max < 100) ink++;
		}
		return (
			opaque / total >= SCAN_OPAQUE_MIN_FRACTION &&
			white / total >= SCAN_WHITE_MIN_FRACTION &&
			saturated / total <= SCAN_SATURATED_MAX_FRACTION &&
			ink / total >= SCAN_INK_MIN_FRACTION
		);
	} catch {
		// Tainted or detached sources never qualify.
		return false;
	}
}

export function isScanPaperSource(
	source: CanvasImageSource,
	crop?: SourceCrop,
): boolean {
	const size = sourceSize(source);
	if (!size || size.width <= 0 || size.height <= 0) return false;
	const fullSource =
		!crop ||
		(crop.sx === 0 &&
			crop.sy === 0 &&
			crop.sw === size.width &&
			crop.sh === size.height);
	const bitmap =
		fullSource &&
		typeof ImageBitmap !== "undefined" &&
		source instanceof ImageBitmap
			? source
			: null;
	if (bitmap) {
		const cached = bitmapVerdicts.get(bitmap);
		if (cached !== undefined) return cached;
	}
	const region = crop ?? { sx: 0, sy: 0, sw: size.width, sh: size.height };
	if (region.sw <= 0 || region.sh <= 0) return false;
	const verdict = isScanPaperSample(source, region);
	if (bitmap) bitmapVerdicts.set(bitmap, verdict);
	return verdict;
}
