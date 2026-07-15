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
 * PDFs encode a page as strips or grids (8×8 grids put single tiles under
 * 2%) whose areas only paper the page in sum. The floor only excludes
 * degenerate sliver spam — the density, saturation, page-level ink and
 * paint-serial guards do the real false-positive filtering.
 */
export const SCAN_TILE_MIN_FRACTION = 0.005;
/**
 * Minimum density (summed tile area / union bounding box area) for pending
 * tiles to read as one contiguous scan: strips partitioning a page are dense,
 * scattered white screenshots on a text page are not.
 */
export const SCAN_TILE_DENSITY_MIN = 0.85;
/** Fraction of near-white opaque pixels above which a source is scan paper. */
export const SCAN_WHITE_MIN_FRACTION = 0.6;
/**
 * Minimum count of dark "ink" pixels in the downsample. A pure-white raster
 * is an MRC background layer (its ink lives in a separate dark layer that
 * must stay un-inverted to remain readable) or a blank page — skip both.
 * A single genuine dark sample suffices so sparse pages (a signature, a few
 * lines) still qualify; downsample averaging already erases isolated noise.
 */
export const SCAN_INK_MIN_PIXELS = 1;
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

const SAMPLE_TARGET_PX = 64;

export interface SourceCrop {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
}

export interface ScanPaperClass {
	/**
	 * Whether the paper carries dark ink pixels. A pure-white raster is an
	 * MRC background layer (its ink lives in a separate dark layer that must
	 * stay readable) or a blank margin tile — pages only invert when ink is
	 * present somewhere, but blank tiles still count toward tiled coverage.
	 */
	inked: boolean;
}

// ImageBitmaps are immutable — one whole-source verdict per bitmap. Canvas
// sources get repainted (pdf.js reuses scratch canvases) and cropped draws
// vary per call, so those are re-sampled per draw.
const bitmapVerdicts = new WeakMap<ImageBitmap, ScanPaperClass | null>();

// One reusable scratch canvas: sampling is synchronous and strip-encoded
// pages can classify many draws per render — no per-draw allocations.
let scratchCanvas: HTMLCanvasElement | null = null;
function getScratchContext(
	width: number,
	height: number,
): CanvasRenderingContext2D | null {
	if (typeof document === "undefined") return null;
	scratchCanvas ??= document.createElement("canvas");
	// Resizing also clears the previous sample.
	scratchCanvas.width = width;
	scratchCanvas.height = height;
	return scratchCanvas.getContext("2d", { willReadFrequently: true });
}

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

// `undefined` = sampling itself failed (canvas pressure, tainted source) and
// the verdict must not be cached; `null` = definitively not scan paper.
function sampleScanPaper(
	source: CanvasImageSource,
	crop: SourceCrop,
): ScanPaperClass | null | undefined {
	const scale = Math.min(1, SAMPLE_TARGET_PX / Math.max(crop.sw, crop.sh));
	const w = Math.max(1, Math.round(crop.sw * scale));
	const h = Math.max(1, Math.round(crop.sh * scale));
	const ctx = getScratchContext(w, h);
	if (!ctx) return undefined;
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
		const isPaper =
			opaque / total >= SCAN_OPAQUE_MIN_FRACTION &&
			white / total >= SCAN_WHITE_MIN_FRACTION &&
			saturated / total <= SCAN_SATURATED_MAX_FRACTION;
		if (!isPaper) return null;
		return { inked: ink >= SCAN_INK_MIN_PIXELS };
	} catch {
		return undefined;
	}
}

export function classifyScanPaper(
	source: CanvasImageSource,
	crop?: SourceCrop,
): ScanPaperClass | null {
	const size = sourceSize(source);
	if (!size || size.width <= 0 || size.height <= 0) return null;
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
	const region = {
		...(crop ?? { sx: 0, sy: 0, sw: size.width, sh: size.height }),
	};
	// drawImage accepts negative source dimensions (normalized rectangles).
	if (region.sw < 0) {
		region.sx += region.sw;
		region.sw = -region.sw;
	}
	if (region.sh < 0) {
		region.sy += region.sh;
		region.sh = -region.sh;
	}
	if (region.sw === 0 || region.sh === 0) return null;
	const verdict = sampleScanPaper(source, region);
	// Transient failures are not verdicts — retry on the next draw.
	if (verdict === undefined) return null;
	if (bitmap) bitmapVerdicts.set(bitmap, verdict);
	return verdict;
}

export function isScanPaperSource(
	source: CanvasImageSource,
	crop?: SourceCrop,
): boolean {
	return classifyScanPaper(source, crop)?.inked === true;
}
