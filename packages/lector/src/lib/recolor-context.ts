import type { RenderColorMap } from "./dark-mode";

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
	if (
		!(source instanceof HTMLCanvasElement) &&
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

/**
 * Recolors a 2D context at draw time: every fill/stroke whose style is a
 * string is painted with `map(style)` and the original style is restored
 * right after, so pdf.js readbacks (`ctx.fillStyle`, `copyCtxState`,
 * save/restore) always observe original-document colors and nothing is ever
 * mapped twice. Gradients are recolored per stop at creation. `drawImage`
 * and `putImageData` are deliberately untouched — photos keep their pixels —
 * with one exception: a drawImage that composes a luminosity soft mask
 * (destination-in through a pdf.js `*_luminosity_map_*` filter) draws a
 * luma-corrected copy of the mask so the recoloring doesn't invert the
 * mask's alpha.
 *
 * Wrapping installs own properties on the context instance (the prototype is
 * never modified). Returns a cleanup that restores the pristine context.
 */
export function applyContextRecolor(
	ctx: CanvasRenderingContext2D,
	map: RenderColorMap,
): () => void {
	const target = ctx as RecolorableContext;
	// Re-wrapping replaces the previous map instead of stacking wrappers.
	target[RECOLOR_CLEANUP]?.();

	// Luma poles of the map's neutral ramp, in pixel space: where pure white
	// and pure black land after recoloring.
	const mappedWhiteLuma = parseHexLuma(map("#ffffff"));
	const mappedBlackLuma = parseHexLuma(map("#000000"));

	const withMaskCorrection = (original: AnyFn) =>
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
					(source instanceof HTMLCanvasElement ||
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
			}
			return original.apply(this, args);
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
	record.drawImage = withMaskCorrection(target.drawImage as AnyFn);

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
