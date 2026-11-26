import assert from "node:assert/strict";
import { test } from "node:test";
import { type BitmapView, paperVerdict } from "../src/scan-paper.ts";

type Px = (x: number, y: number) => [number, number, number, number];

function bitmap(width: number, height: number, bpp: 1 | 4, px: Px): BitmapView {
	const stride = width * bpp;
	const data = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = px(x, y);
			const o = y * stride + x * bpp;
			if (bpp === 1) data[o] = r;
			else data.set([b, g, r, a], o);
		}
	return { data, offset: 0, width, height, stride, bpp, alpha: bpp === 4 };
}

// 300 dpi book page: 2px strokes, 7px glyph pitch, 40px line pitch, wide margins.
const textScan: Px = (x, y) => {
	const inText =
		x > 300 && x < 2000 && y > 300 && y < 2900 && y % 40 < 22 && x % 7 < 2;
	const v = inText ? 0 : 255;
	return [v, v, v, 255];
};

test("a 1-bit text scan is inked paper", () => {
	assert.deepEqual(paperVerdict(bitmap(2288, 3227, 1, textScan)), {
		inked: true,
	});
});

const renderedScan =
	(w: number, h: number, edge: number): Px =>
	(x, y) => {
		const onEdge = x < edge || y >= h - edge;
		const ink = y % 14 < 8 && x % 3 === 0 && x > 10 && x < w - 10;
		const v = ink ? 0 : 255;
		return [v, v, v, onEdge ? 120 : 255];
	};

test("a rendered scan's antialiased edge, up to 3px, does not make it a cut-out", () => {
	assert.deepEqual(
		paperVerdict(bitmap(793, 613, 4, renderedScan(793, 613, 3))),
		{ inked: true },
	);
});

test("a short strip tile with an antialiased edge is still paper", () => {
	assert.deepEqual(
		paperVerdict(bitmap(2480, 96, 4, renderedScan(2480, 96, 2))),
		{ inked: true },
	);
});

test("a slightly rotated (deskewed) scan's transparent corner wedges do not make it a cut-out", () => {
	const w = 550;
	const h = 775;
	const wedge: Px = (x, y) => {
		const [r, g, b] = renderedScan(w, h, 0)(x, y);
		return [r, g, b, y < 9 - x / 60 || x < 12 - y / 60 ? 0 : 255];
	};
	assert.deepEqual(paperVerdict(bitmap(w, h, 4, wedge)), { inked: true });
});

test("transparent padding wider than an antialiased edge is a cut-out", () => {
	assert.equal(
		paperVerdict(bitmap(400, 400, 4, renderedScan(400, 400, 40))),
		null,
	);
});

test("blank paper is paper without ink", () => {
	assert.deepEqual(
		paperVerdict(bitmap(600, 800, 1, () => [250, 250, 250, 255])),
		{ inked: false },
	);
});

test("a cut-out with transparent interior is not paper", () => {
	const cut = bitmap(400, 400, 4, (x, y) =>
		Math.hypot(x - 200, y - 200) < 120 ? [0, 0, 0, 0] : [255, 255, 255, 255],
	);
	assert.equal(paperVerdict(cut), null);
});

test("a colourful photo is not paper", () => {
	const photo = bitmap(320, 220, 4, (x, y) => [
		Math.round((255 * x) / 320),
		80,
		Math.round((255 * y) / 220),
		255,
	]);
	assert.equal(paperVerdict(photo), null);
});
