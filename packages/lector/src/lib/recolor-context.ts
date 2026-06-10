import type { RenderColorMap } from "./dark-mode";

const RECOLOR_CLEANUP = Symbol("lectorRecolorCleanup");

type RecolorableContext = CanvasRenderingContext2D & {
	[RECOLOR_CLEANUP]?: () => void;
};

type AnyFn = (this: CanvasRenderingContext2D, ...args: never[]) => unknown;

const FILL_METHODS = ["fill", "fillRect", "fillText"] as const;
const STROKE_METHODS = ["stroke", "strokeRect", "strokeText"] as const;
const GRADIENT_METHODS = [
	"createLinearGradient",
	"createRadialGradient",
] as const;

/**
 * Recolors a 2D context at draw time: every fill/stroke whose style is a
 * string is painted with `map(style)` and the original style is restored
 * right after, so pdf.js readbacks (`ctx.fillStyle`, `copyCtxState`,
 * save/restore) always observe original-document colors and nothing is ever
 * mapped twice. Gradients are recolored per stop at creation. `drawImage`
 * and `putImageData` are deliberately untouched — photos keep their pixels.
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

	const withMappedStyle = (
		original: AnyFn,
		styleProp: "fillStyle" | "strokeStyle",
	) =>
		function (this: CanvasRenderingContext2D, ...args: never[]): unknown {
			const style = this[styleProp];
			if (typeof style === "string") {
				const mapped = map(style);
				if (mapped !== style) {
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
			gradient.addColorStop = (offset: number, color: string) => {
				addColorStop(offset, map(color));
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

	const cleanup = () => {
		// A later applyContextRecolor call already replaced these wrappers.
		if (target[RECOLOR_CLEANUP] !== cleanup) return;
		for (const name of [
			...FILL_METHODS,
			...STROKE_METHODS,
			...GRADIENT_METHODS,
		])
			delete record[name];
		delete target[RECOLOR_CLEANUP];
	};
	target[RECOLOR_CLEANUP] = cleanup;
	return cleanup;
}
