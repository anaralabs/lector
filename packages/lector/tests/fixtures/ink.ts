/** Pixel-space box of the dark, opaque pixels in a raster (the drawn glyphs). */
export function inkBounds(
	pixels: Uint8ClampedArray,
	width: number,
	height: number,
) {
	let left = width,
		top = height,
		right = 0,
		bottom = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = (y * width + x) * 4;
			if (pixels[index]! < 128 && pixels[index + 3]! > 128) {
				left = Math.min(left, x);
				top = Math.min(top, y);
				right = Math.max(right, x + 1);
				bottom = Math.max(bottom, y + 1);
			}
		}
	}
	return { left, top, right, bottom };
}
