import { describe, expect, it } from "vitest";
import { toLayerRect } from "../src/lib/selection-background";

// A 560x420 layer with one selected run at (45, 110), 220x18 in layer space.
const layer = { width: 560, height: 420 };
const run = { left: 45, top: 110, width: 220, height: 18 };

// Where that run lands on screen once the page is rotated and zoomed.
const onScreen = (rotation: number, zoom: number) => {
	const { left: x, top: y, width: w, height: h } = run;
	const { width: W, height: H } = layer;
	const [left, top, width, height] =
		rotation === 90
			? [H - y - h, x, h, w]
			: rotation === 180
				? [W - x - w, H - y - h, w, h]
				: rotation === 270
					? [y, W - x - w, h, w]
					: [x, y, w, h];
	const sideways = rotation === 90 || rotation === 270;
	return {
		rect: {
			left: 290 + left * zoom,
			top: 73 + top * zoom,
			width: width * zoom,
			height: height * zoom,
		},
		bounds: {
			left: 290,
			top: 73,
			width: (sideways ? layer.height : layer.width) * zoom,
			height: (sideways ? layer.width : layer.height) * zoom,
		},
	};
};

describe("toLayerRect", () => {
	for (const rotation of [0, 90, 180, 270]) {
		for (const zoom of [0.75, 1, 1.75]) {
			it(`undoes ${rotation} degrees at ${zoom}x`, () => {
				const { rect, bounds } = onScreen(rotation, zoom);
				const mapped = toLayerRect(
					rect,
					bounds,
					layer.width,
					layer.height,
					rotation,
				);
				for (const key of ["left", "top", "width", "height"] as const)
					expect(mapped[key]).toBeCloseTo(run[key], 5);
			});
		}
	}
});
