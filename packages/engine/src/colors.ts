// Colour maths shared by the compositor and hosts: what the engine actually
// paints, so host UI (legends, swatches, overlays) can match it.

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/**
 * Dark-mode tone mapping of a page colour (0-1 rgb), as the tile shader does:
 * lightness inverts (white paper -> `paper`, black ink -> `ink`) and hue stays.
 * `gamma` is the engine's glyph gamma (default 1.25).
 */
export function toneMap(rgb: RGB, paper: RGB, ink: RGB, gamma = 1.25): RGB {
	const c = rgb.map((v) => Math.max(0, v) ** gamma) as RGB;
	const l = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
	const t = 1 - l;
	return [0, 1, 2].map((i) => Math.min(1, Math.max(0, paper[i]! + (ink[i]! - paper[i]!) * t + (c[i]! - l) * 0.8))) as RGB;
}

/**
 * The opaque colour a highlight/selection fill (rgb + alpha strength) is drawn
 * with. Light mode: the colour composited over white, multiplied over the page
 * (black ink stays black). Dark mode (`paper` given): a deep version of the
 * colour over the paper, drawn with a per-channel max, so light ink stays on
 * top; alpha is boosted because light-mode alphas read too faint on dark.
 */
export function markColor(color: RGBA, paper?: RGB | null): RGBA {
	const [r, g, b, a] = color;
	if (!paper) return [1 - a * (1 - r), 1 - a * (1 - g), 1 - a * (1 - b), 1];
	const k = Math.min(1, a * 1.8);
	return [paper[0] + (r * 0.55 - paper[0]) * k, paper[1] + (g * 0.55 - paper[1]) * k, paper[2] + (b * 0.55 - paper[2]) * k, 1];
}
