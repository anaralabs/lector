export type ColorScheme = "light" | "dark";

export interface DarkModeColors {
	/** Replaces the white paper background. Any CSS hex/rgb color. */
	background?: string;
	/** Replaces black text and line art. Any CSS hex/rgb color. */
	foreground?: string;
}

/**
 * Maps a color from the original document to its dark-scheme equivalent.
 * Unparseable and fully-transparent colors are returned unchanged.
 */
export type RenderColorMap = (color: string) => string;

export const DEFAULT_DARK_MODE_COLORS: Required<DarkModeColors> = {
	background: "#181a1b",
	foreground: "#e8e6e3",
};

type Rgba = [number, number, number, number];
type Lab = [number, number, number];

const NAMED_COLORS: Record<string, Rgba> = {
	white: [1, 1, 1, 1],
	black: [0, 0, 0, 1],
	transparent: [0, 0, 0, 0],
};

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function parseColor(input: string): Rgba | null {
	const str = input.trim().toLowerCase();
	const named = NAMED_COLORS[str];
	if (named) return named;

	if (str.startsWith("#")) {
		const hex = str.slice(1);
		if (!/^[0-9a-f]{3,8}$/.test(hex)) return null;
		if (hex.length === 3 || hex.length === 4) {
			const r = Number.parseInt(hex[0]!, 16) / 15;
			const g = Number.parseInt(hex[1]!, 16) / 15;
			const b = Number.parseInt(hex[2]!, 16) / 15;
			const a = hex.length === 4 ? Number.parseInt(hex[3]!, 16) / 15 : 1;
			return [r, g, b, a];
		}
		if (hex.length === 6 || hex.length === 8) {
			const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
			const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
			const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
			const a =
				hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
			return [r, g, b, a];
		}
		return null;
	}

	const fn = /^rgba?\(([^)]+)\)$/.exec(str);
	if (fn) {
		const parts = fn[1]!.split(/[,\s/]+/).filter(Boolean);
		if (parts.length < 3) return null;
		const channel = (part: string) =>
			part.endsWith("%")
				? Number.parseFloat(part) / 100
				: Number.parseFloat(part) / 255;
		const alpha = (part: string) =>
			part.endsWith("%")
				? Number.parseFloat(part) / 100
				: Number.parseFloat(part);
		const r = channel(parts[0]!);
		const g = channel(parts[1]!);
		const b = channel(parts[2]!);
		const a = parts[3] !== undefined ? alpha(parts[3]) : 1;
		if (
			Number.isNaN(r) ||
			Number.isNaN(g) ||
			Number.isNaN(b) ||
			Number.isNaN(a)
		)
			return null;
		return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
	}

	// Last resort for the rest of the CSS color grammar (named colors,
	// hsl()/oklch()/color-mix()/...): let the browser normalize it to a
	// hex/rgba serialization, then parse that.
	const normalized = normalizeCssColor(str);
	if (normalized !== null && normalized !== str) return parseColor(normalized);

	return null;
}

let normalizeCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Normalizes any valid CSS color to its canvas fillStyle serialization
 * ("#rrggbb" or "rgba(...)"). Returns null for invalid colors (assigning
 * one leaves fillStyle unchanged, detected by priming with two different
 * values) and outside the DOM (SSR).
 */
function normalizeCssColor(input: string): string | null {
	if (normalizeCtx === undefined) {
		normalizeCtx =
			typeof document === "undefined"
				? null
				: document.createElement("canvas").getContext("2d", {
						willReadFrequently: true,
					});
	}
	const ctx = normalizeCtx;
	if (!ctx) return null;
	ctx.fillStyle = "#000000";
	ctx.fillStyle = input;
	const first = ctx.fillStyle;
	ctx.fillStyle = "#ffffff";
	ctx.fillStyle = input;
	return first === ctx.fillStyle ? first : null;
}

function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
	return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

// sRGB <-> OKLab, reference implementation by Björn Ottosson (public domain).
function rgbToOklab(r: number, g: number, b: number): Lab {
	const lr = srgbToLinear(r);
	const lg = srgbToLinear(g);
	const lb = srgbToLinear(b);
	const l = Math.cbrt(
		0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
	);
	const m = Math.cbrt(
		0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
	);
	const s = Math.cbrt(
		0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
	);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function oklabToLinearRgb(L: number, a: number, b: number): Lab {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const GAMUT_EPSILON = 0.0005;

function oklabToSrgbExact(L: number, a: number, b: number): Lab | null {
	const [lr, lg, lb] = oklabToLinearRgb(L, a, b);
	if (
		lr < -GAMUT_EPSILON ||
		lr > 1 + GAMUT_EPSILON ||
		lg < -GAMUT_EPSILON ||
		lg > 1 + GAMUT_EPSILON ||
		lb < -GAMUT_EPSILON ||
		lb > 1 + GAMUT_EPSILON
	) {
		return null;
	}
	return [
		linearToSrgb(clamp01(lr)),
		linearToSrgb(clamp01(lg)),
		linearToSrgb(clamp01(lb)),
	];
}

/** Reduce chroma until the color fits the sRGB gamut, then hard-clamp. */
function oklabToSrgbGamutMapped(L: number, a: number, b: number): Lab {
	const exact = oklabToSrgbExact(L, a, b);
	if (exact) return exact;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 12; i++) {
		const mid = (lo + hi) / 2;
		if (oklabToSrgbExact(L, a * mid, b * mid)) lo = mid;
		else hi = mid;
	}
	const [lr, lg, lb] = oklabToLinearRgb(L, a * lo, b * lo);
	return [
		linearToSrgb(clamp01(lr)),
		linearToSrgb(clamp01(lg)),
		linearToSrgb(clamp01(lb)),
	];
}

function toHexByte(channel: number): string {
	return Math.round(clamp01(channel) * 255)
		.toString(16)
		.padStart(2, "0");
}

function toCssColor(r: number, g: number, b: number, a: number): string {
	const rgb = `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
	return a >= 1 ? rgb : `${rgb}${toHexByte(a)}`;
}

// Above this OKLab chroma a color fully keeps its own hue/chroma; below it,
// it is progressively pulled onto the background<->foreground ramp so the
// palette's tint applies to grays too.
const NEUTRAL_CHROMA_THRESHOLD = 0.04;

const COLOR_CACHE_MAX = 4096;
const mapInstances = new Map<string, RenderColorMap>();

/**
 * Builds a memoized color map that flips perceived lightness onto the
 * background<->foreground ramp while preserving hue and chroma (OKLab).
 * Position on the ramp follows gamma-encoded BT.709 luma — the same measure
 * "luminance inversion" night modes use — so saturated accents move the way
 * readers expect (red becomes pink, not cyan; blue links become light blue).
 * Neutrals land exactly on the ramp: white maps to `background`, black to
 * `foreground`, including the palette's tint.
 */
export function createDarkModeColorMap(
	colors?: DarkModeColors,
): RenderColorMap {
	const background = colors?.background ?? DEFAULT_DARK_MODE_COLORS.background;
	const foreground = colors?.foreground ?? DEFAULT_DARK_MODE_COLORS.foreground;
	const instanceKey = `${background}|${foreground}`;
	const existing = mapInstances.get(instanceKey);
	if (existing) return existing;

	const bgRgba =
		parseColor(background) ?? parseColor(DEFAULT_DARK_MODE_COLORS.background)!;
	const fgRgba =
		parseColor(foreground) ?? parseColor(DEFAULT_DARK_MODE_COLORS.foreground)!;
	const bgLab = rgbToOklab(bgRgba[0], bgRgba[1], bgRgba[2]);
	const fgLab = rgbToOklab(fgRgba[0], fgRgba[1], fgRgba[2]);

	const cache = new Map<string, string>();
	// Exact poles: pure white/black must reproduce the palette strings
	// verbatim (no float round-tripping), so page backgrounds match CSS.
	const backgroundCss = toCssColor(bgRgba[0], bgRgba[1], bgRgba[2], 1);
	const foregroundCss = toCssColor(fgRgba[0], fgRgba[1], fgRgba[2], 1);
	const seedPoles = () => {
		for (const white of ["#ffffff", "#fff", "white"])
			cache.set(white, backgroundCss);
		for (const black of ["#000000", "#000", "black"])
			cache.set(black, foregroundCss);
	};
	seedPoles();

	const transform = (input: string): string => {
		const parsed = parseColor(input);
		if (!parsed || parsed[3] === 0) return input;
		const [r, g, b, alpha] = parsed;
		const [, labA, labB] = rgbToOklab(r, g, b);
		// Gamma-encoded BT.709 luma as ramp position: 0 = black, 1 = white.
		const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		const rampL = fgLab[0] + (bgLab[0] - fgLab[0]) * luma;
		const rampA = fgLab[1] + (bgLab[1] - fgLab[1]) * luma;
		const rampB = fgLab[2] + (bgLab[2] - fgLab[2]) * luma;
		const chroma = Math.hypot(labA, labB);
		const hueWeight = Math.min(1, chroma / NEUTRAL_CHROMA_THRESHOLD);
		const outA = rampA + (labA - rampA) * hueWeight;
		const outB = rampB + (labB - rampB) * hueWeight;
		const [sr, sg, sb] = oklabToSrgbGamutMapped(rampL, outA, outB);
		return toCssColor(sr, sg, sb, alpha);
	};

	const map: RenderColorMap = (input) => {
		const hit = cache.get(input);
		if (hit !== undefined) return hit;
		const out = transform(input);
		if (cache.size >= COLOR_CACHE_MAX) {
			cache.clear();
			seedPoles();
		}
		cache.set(input, out);
		return out;
	};

	if (mapInstances.size >= 16) mapInstances.clear();
	mapInstances.set(instanceKey, map);
	return map;
}
