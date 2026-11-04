// Per-pixel work the WebGL shader does per frame, done once per tile for the 2D compositor (in the raster workers).

export const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Gamma, then (with a tone) the shader's dark curve, in place; boxes (tile pixels, x0 y0 x1 y1) keep their colours. */
export function bakePixels(d: Uint8Array | Uint8ClampedArray, w: number, h: number, gamma: number, tone: readonly number[] | null, boxes: readonly number[] = []) {
	if (gamma !== 1) {
		const t = new Uint8Array(256);
		for (let i = 0; i < 256; i++) t[i] = byte((i / 255) ** gamma);
		for (let i = 0; i < d.length; i += 4) {
			d[i] = t[d[i]!]!;
			d[i + 1] = t[d[i + 1]!]!;
			d[i + 2] = t[d[i + 2]!]!;
		}
	}
	if (!tone) return;
	// c' = ink + 0.8c - (ink - paper + 0.8) * luma(c): linear in c, so one multiply-add per channel.
	const [pr, pg, pb, ir, ig, ib] = tone as [number, number, number, number, number, number];
	const kr = ir - pr + 0.8;
	const kg = ig - pg + 0.8;
	const kb = ib - pb + 0.8;
	const ar = ir * 255;
	const ag = ig * 255;
	const ab = ib * 255;
	for (let y = 0; y < h; y++) {
		let skip: number[] | null = null;
		for (let i = 0; i < boxes.length; i += 4) {
			if (y < boxes[i + 1]! || y >= boxes[i + 3]!) continue;
			skip ??= [];
			skip.push(boxes[i]!, boxes[i + 2]!);
		}
		let x = 0;
		while (x < w) {
			let end = w;
			if (skip) {
				let inside = false;
				for (let i = 0; i < skip.length; i += 2) {
					if (x >= skip[i]! && x < skip[i + 1]!) {
						x = Math.min(w, Math.ceil(skip[i + 1]!));
						inside = true;
						break;
					}
					if (skip[i]! > x) end = Math.min(end, Math.floor(skip[i]!));
				}
				if (inside) continue;
			}
			for (let o = (y * w + x) * 4, e = (y * w + end) * 4; o < e; o += 4) {
				const r = d[o]!;
				const g = d[o + 1]!;
				const b = d[o + 2]!;
				const l = 0.299 * r + 0.587 * g + 0.114 * b;
				d[o] = ar + 0.8 * r - kr * l;
				d[o + 1] = ag + 0.8 * g - kg * l;
				d[o + 2] = ab + 0.8 * b - kb * l;
			}
			x = end;
		}
	}
}
