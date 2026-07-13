import type { RenderColorMap } from "./dark-mode";
import {
	isScanPaperSource,
	SCAN_COVERAGE_MIN,
	SCAN_TILE_DENSITY_MIN,
	SCAN_TILE_MIN_FRACTION,
	sourceSize,
} from "./scan-invert";

const RECOLOR_CLEANUP = Symbol("lectorRecolorCleanup");
const RECOLOR_PAINTED = Symbol("lectorRecolorPainted");

type RecolorableContext = CanvasRenderingContext2D & {
	[RECOLOR_CLEANUP]?: () => void;
	/** True once any draw on this context actually swapped a color. */
	[RECOLOR_PAINTED]?: boolean;
};

type AnyFn = (this: CanvasRenderingContext2D, ...args: never[]) => unknown;

const FILL_METHODS = ["fill", "fillRect", "fillText"] as const;
const STROKE_METHODS = ["stroke", "strokeRect", "strokeText"] as const;
const GRADIENT_METHODS = [
	"createLinearGradient",
	"createRadialGradient",
] as const;

// NTSC weights — the same ones pdf.js's luminosity SVG filter uses.
function ntscLuma(r: number, g: number, b: number): number {
	return 0.3 * r + 0.59 * g + 0.11 * b;
}

function parseHexLuma(color: string): number | null {
	if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
	return ntscLuma(
		Number.parseInt(color.slice(1, 3), 16),
		Number.parseInt(color.slice(3, 5), 16),
		Number.parseInt(color.slice(5, 7), 16),
	);
}

/**
 * pdf.js composes a luminosity soft mask by drawing the mask canvas through
 * a luminosity SVG filter with `destination-in`: pixel luma BECOMES alpha.
 * The mask artwork was painted through the recolor map (white flipped to the
 * dark background and vice versa), so its luma — and therefore the mask's
 * alpha — would be inverted: visible content disappears, hidden content
 * appears. This produces a copy of the mask with the neutral luma ramp
 * un-mapped (mapped-white luma back to 255, mapped-black back to 0) for the
 * filter to consume. Exact for neutral/binary masks; midtones land within a
 * few percent (the OKLab ramp is not affine in luma).
 *
 * Only called for mask canvases that actually painted recolored content
 * (RECOLOR_PAINTED): the un-map ramp is itself an inversion, so applying it
 * to never-recolored pixels — image-based masks, drawn via the untouched
 * drawImage — would invert THEIR alpha instead. Masks mixing recolored
 * vector art with images remain imperfect for the image part.
 */
function correctLuminosityMask(
	source: CanvasImageSource,
	mappedWhiteLuma: number,
	mappedBlackLuma: number,
): HTMLCanvasElement | null {
	if (typeof document === "undefined") return null;
	if (
		!(
			typeof HTMLCanvasElement !== "undefined" &&
			source instanceof HTMLCanvasElement
		) &&
		!(
			typeof OffscreenCanvas !== "undefined" &&
			source instanceof OffscreenCanvas
		)
	) {
		return null;
	}
	const width = source.width;
	const height = source.height;
	if (!width || !height) return null;
	const span = mappedWhiteLuma - mappedBlackLuma;
	if (Math.abs(span) < 1) return null;

	const tmp = document.createElement("canvas");
	tmp.width = width;
	tmp.height = height;
	const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });
	if (!tmpCtx) return null;
	tmpCtx.drawImage(source, 0, 0);
	let image: ImageData;
	try {
		image = tmpCtx.getImageData(0, 0, width, height);
	} catch {
		return null;
	}
	const data = image.data;
	for (let i = 0; i < data.length; i += 4) {
		const luma = ntscLuma(data[i]!, data[i + 1]!, data[i + 2]!);
		const t = (luma - mappedBlackLuma) / span;
		const gray = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
		data[i] = data[i + 1] = data[i + 2] = gray;
	}
	tmpCtx.putImageData(image, 0, 0);
	return tmp;
}

export interface RecolorContextOptions {
	/**
	 * Full-page area in the context's device space (viewport.width × height).
	 * When provided, image draws that paper the page (≥ SCAN_COVERAGE_MIN of
	 * this area) with near-white pixels — scanned pages — are inverted toward
	 * the palette poles. Omit on pdf.js scratch canvases, whose device space
	 * is not the page; a page-covering scan painted through one is still
	 * caught when the scratch canvas is composed back onto a page context.
	 */
	pageArea?: number;
}

/**
 * Recolors a 2D context at draw time: every fill/stroke whose style is a
 * string is painted with `map(style)` and the original style is restored
 * right after, so pdf.js readbacks (`ctx.fillStyle`, `copyCtxState`,
 * save/restore) always observe original-document colors and nothing is ever
 * mapped twice. Gradients are recolored per stop at creation. `drawImage`
 * and `putImageData` keep image pixels untouched — photos stay photos — with
 * two exceptions: a drawImage that composes a luminosity soft mask
 * (destination-in through a pdf.js `*_luminosity_map_*` filter) draws a
 * luma-corrected copy of the mask so the recoloring doesn't invert the
 * mask's alpha, and a drawImage that papers the page with near-white pixels
 * (a scanned page) is inverted toward the palette poles right after painting
 * (policy in ./scan-invert.ts).
 *
 * Wrapping installs own properties on the context instance (the prototype is
 * never modified). Returns a cleanup that restores the pristine context.
 */
export function applyContextRecolor(
	ctx: CanvasRenderingContext2D,
	map: RenderColorMap,
	options?: RecolorContextOptions,
): () => void {
	const target = ctx as RecolorableContext;
	// Re-wrapping replaces the previous map instead of stacking wrappers.
	target[RECOLOR_CLEANUP]?.();

	// Luma poles of the map's neutral ramp, in pixel space: where pure white
	// and pure black land after recoloring.
	const mappedWhiteLuma = parseHexLuma(map("#ffffff"));
	const mappedBlackLuma = parseHexLuma(map("#000000"));

	const pageArea = options?.pageArea;
	const scanEnabled =
		!!pageArea &&
		pageArea > 0 &&
		mappedWhiteLuma !== null &&
		mappedBlackLuma !== null;
	// Difference-filling with this gray sends scan paper (255) exactly to the
	// mapped white pole's luma; an affine luma remap then pins ink to the
	// foreground pole (paper is a fixed point of the remap), and a final
	// color-blend fill tints the neutral result toward the palette background
	// so tinted palettes match vector pages instead of landing on plain gray.
	const scanInvertGray = scanEnabled ? 255 - Math.round(mappedWhiteLuma) : null;
	const scanTintCss = scanEnabled ? map("#ffffff") : null;
	let inkScaleGray = 255;
	let inkOffsetGray = 0;
	if (scanEnabled) {
		const inkLuma = 255 - mappedWhiteLuma; // where ink lands post-difference
		const span = inkLuma - mappedWhiteLuma;
		if (span > 8) {
			const scale = Math.min(
				1,
				Math.max(0, (mappedBlackLuma - mappedWhiteLuma) / span),
			);
			inkScaleGray = Math.round(scale * 255);
			inkOffsetGray = Math.round(mappedWhiteLuma * (1 - scale));
		}
	}
	const needsInkRemap = inkScaleGray < 253 || inkOffsetGray > 2;
	// Captured pre-wrap: the inversion fills must not run through the
	// style-mapping fillRect wrapper installed below.
	const pristineFillRect = target.fillRect;

	type DestRect = [number, number, number, number];
	type DeviceBounds = [number, number, number, number];

	const destRect = (args: readonly unknown[]): DestRect | null => {
		if (args.length >= 9) {
			return [args[5], args[6], args[7], args[8]] as DestRect;
		}
		if (args.length >= 5) {
			return [args[1], args[2], args[3], args[4]] as DestRect;
		}
		const size = sourceSize(args[0] as CanvasImageSource);
		if (!size) return null;
		return [
			(args[1] as number) ?? 0,
			(args[2] as number) ?? 0,
			size.width,
			size.height,
		];
	};

	// A candidate draw paints white paper under a plain composite. Checks run
	// cheapest-first; pixel sampling (isScanPaperSource) comes last, and for
	// cropped draws it samples exactly the drawn source region.
	const scanCandidate = (
		self: CanvasRenderingContext2D,
		args: readonly unknown[],
	): { rect: DestRect; areaFraction: number } | null => {
		if (!scanEnabled || !pageArea) return null;
		if (self.globalCompositeOperation !== "source-over") return null;
		if (self.globalAlpha < 0.99) return null;
		const filter = self.filter;
		if (typeof filter === "string" && filter !== "none" && filter !== "")
			return null;
		const rect = destRect(args);
		if (!rect) return null;
		const t = self.getTransform();
		const painted =
			Math.abs(t.a * t.d - t.b * t.c) * Math.abs(rect[2] * rect[3]);
		const areaFraction = painted / pageArea;
		if (areaFraction < SCAN_TILE_MIN_FRACTION) return null;
		const crop =
			args.length >= 9
				? {
						sx: args[1] as number,
						sy: args[2] as number,
						sw: args[3] as number,
						sh: args[4] as number,
					}
				: undefined;
		if (!isScanPaperSource(args[0] as CanvasImageSource, crop)) return null;
		return { rect, areaFraction };
	};

	const grayCss = (value: number) => `rgb(${value}, ${value}, ${value})`;

	const invertScanRect = (
		self: CanvasRenderingContext2D,
		rect: DestRect,
		matrix: DOMMatrix,
	) => {
		self.save();
		self.setTransform(matrix);
		self.globalAlpha = 1;
		self.globalCompositeOperation = "difference";
		self.fillStyle = grayCss(scanInvertGray ?? 0);
		pristineFillRect.call(self, rect[0], rect[1], rect[2], rect[3]);
		if (needsInkRemap) {
			self.globalCompositeOperation = "multiply";
			self.fillStyle = grayCss(inkScaleGray);
			pristineFillRect.call(self, rect[0], rect[1], rect[2], rect[3]);
			if (inkOffsetGray > 0) {
				self.globalCompositeOperation = "lighter";
				self.fillStyle = grayCss(inkOffsetGray);
				pristineFillRect.call(self, rect[0], rect[1], rect[2], rect[3]);
			}
		}
		if (scanTintCss) {
			// Keep the inverted luma, adopt the palette's hue/chroma.
			self.globalCompositeOperation = "color";
			self.fillStyle = scanTintCss;
			pristineFillRect.call(self, rect[0], rect[1], rect[2], rect[3]);
		}
		self.restore();
	};

	// Tiled scans: some raster PDFs paint a page as strips whose areas only
	// paper the page in sum. Pending white tiles accumulate (per render pass —
	// the wrapper is re-applied per render) and are inverted retroactively
	// once they sum to page coverage AND tile densely (summed area ≈ their
	// union box), which scattered white screenshots on a text page never do.
	// Overlapping tiles are never accumulated: a second difference fill would
	// un-invert the overlap (MRC layer stacks land here).
	interface PendingTile {
		rect: DestRect;
		matrix: DOMMatrix;
		bounds: DeviceBounds;
	}
	let scanPageDetected = false;
	let pendingTileArea = 0;
	const pendingTiles: PendingTile[] = [];

	const tileBounds = (matrix: DOMMatrix, rect: DestRect): DeviceBounds => {
		const corners = [
			matrix.transformPoint({ x: rect[0], y: rect[1] }),
			matrix.transformPoint({ x: rect[0] + rect[2], y: rect[1] }),
			matrix.transformPoint({ x: rect[0], y: rect[1] + rect[3] }),
			matrix.transformPoint({ x: rect[0] + rect[2], y: rect[1] + rect[3] }),
		];
		return [
			Math.min(...corners.map((c) => c.x)),
			Math.min(...corners.map((c) => c.y)),
			Math.max(...corners.map((c) => c.x)),
			Math.max(...corners.map((c) => c.y)),
		];
	};

	const boundsOverlap = (a: DeviceBounds, b: DeviceBounds) =>
		a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

	const handleScanCandidate = (
		self: CanvasRenderingContext2D,
		candidate: { rect: DestRect; areaFraction: number },
	) => {
		const matrix = self.getTransform();
		if (scanPageDetected || candidate.areaFraction >= SCAN_COVERAGE_MIN) {
			scanPageDetected = true;
			invertScanRect(self, candidate.rect, matrix);
			return;
		}
		const bounds = tileBounds(matrix, candidate.rect);
		if (pendingTiles.some((tile) => boundsOverlap(tile.bounds, bounds))) return;
		pendingTiles.push({ rect: candidate.rect, matrix, bounds });
		pendingTileArea += candidate.areaFraction;
		if (pendingTileArea < SCAN_COVERAGE_MIN) return;
		const union: DeviceBounds = [
			Math.min(...pendingTiles.map((t) => t.bounds[0])),
			Math.min(...pendingTiles.map((t) => t.bounds[1])),
			Math.max(...pendingTiles.map((t) => t.bounds[2])),
			Math.max(...pendingTiles.map((t) => t.bounds[3])),
		];
		const unionArea = (union[2] - union[0]) * (union[3] - union[1]);
		if (unionArea <= 0) return;
		const density = (pendingTileArea * (pageArea ?? 0)) / unionArea;
		if (density < SCAN_TILE_DENSITY_MIN) return;
		scanPageDetected = true;
		for (const tile of pendingTiles) {
			invertScanRect(self, tile.rect, tile.matrix);
		}
		pendingTiles.length = 0;
	};

	const withImageHandling = (original: AnyFn) =>
		function (this: CanvasRenderingContext2D, ...args: never[]): unknown {
			if (
				mappedWhiteLuma !== null &&
				mappedBlackLuma !== null &&
				this.globalCompositeOperation === "destination-in" &&
				typeof this.filter === "string" &&
				this.filter.includes("luminosity")
			) {
				const source = args[0] as unknown as CanvasImageSource;
				// Un-map only masks whose context actually painted recolored
				// content; never-recolored sources (image-based masks) would
				// get their alpha inverted by the correction instead.
				const sourcePainted =
					((typeof HTMLCanvasElement !== "undefined" &&
						source instanceof HTMLCanvasElement) ||
						(typeof OffscreenCanvas !== "undefined" &&
							source instanceof OffscreenCanvas)) &&
					(source.getContext("2d") as RecolorableContext | null)?.[
						RECOLOR_PAINTED
					] === true;
				const corrected = sourcePainted
					? correctLuminosityMask(source, mappedWhiteLuma, mappedBlackLuma)
					: null;
				if (corrected) {
					const next = [corrected, ...args.slice(1)] as never[];
					return original.apply(this, next);
				}
				return original.apply(this, args);
			}

			const candidate = scanCandidate(this, args);
			const result = original.apply(this, args);
			if (candidate) handleScanCandidate(this, candidate);
			return result;
		};

	const withMappedStyle = (
		original: AnyFn,
		styleProp: "fillStyle" | "strokeStyle",
	) =>
		function (this: CanvasRenderingContext2D, ...args: never[]): unknown {
			const style = this[styleProp];
			if (typeof style === "string") {
				const mapped = map(style);
				if (mapped !== style) {
					(this as RecolorableContext)[RECOLOR_PAINTED] = true;
					this[styleProp] = mapped;
					try {
						return original.apply(this, args);
					} finally {
						this[styleProp] = style;
					}
				}
			}
			return original.apply(this, args);
		};

	const withMappedStops = (original: AnyFn) =>
		function (this: CanvasRenderingContext2D, ...args: never[]): unknown {
			const gradient = original.apply(this, args) as CanvasGradient;
			const addColorStop = gradient.addColorStop.bind(gradient);
			const context = this as RecolorableContext;
			gradient.addColorStop = (offset: number, color: string) => {
				const mapped = map(color);
				if (mapped !== color) context[RECOLOR_PAINTED] = true;
				addColorStop(offset, mapped);
			};
			return gradient;
		};

	const record = target as unknown as Record<string, unknown>;
	for (const name of FILL_METHODS)
		record[name] = withMappedStyle(target[name] as AnyFn, "fillStyle");
	for (const name of STROKE_METHODS)
		record[name] = withMappedStyle(target[name] as AnyFn, "strokeStyle");
	for (const name of GRADIENT_METHODS)
		record[name] = withMappedStops(target[name] as AnyFn);
	record.drawImage = withImageHandling(target.drawImage as AnyFn);

	const cleanup = () => {
		// A later applyContextRecolor call already replaced these wrappers.
		if (target[RECOLOR_CLEANUP] !== cleanup) return;
		for (const name of [
			...FILL_METHODS,
			...STROKE_METHODS,
			...GRADIENT_METHODS,
			"drawImage",
		])
			delete record[name];
		delete target[RECOLOR_CLEANUP];
		delete target[RECOLOR_PAINTED];
	};
	target[RECOLOR_CLEANUP] = cleanup;
	return cleanup;
}

/**
 * Removes any recolor wrapper installed on the context. For long-lived
 * contexts (the visible canvas in the no-buffer fallback, thumbnails) that
 * are about to render in the light scheme: a still-pending dark render's
 * deferred restore could otherwise leave its wrapper active across the
 * scheme switch.
 */
export function removeContextRecolor(ctx: CanvasRenderingContext2D): void {
	(ctx as RecolorableContext)[RECOLOR_CLEANUP]?.();
}
