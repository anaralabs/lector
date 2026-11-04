import { Canvas2DCompositor } from "./canvas2d";
import { type Compositor, type CompositorKind, GLCompositor } from "./gl";

/** WebGL2 unless asked for 2D; a canvas whose WebGL2 context fails to create can still take a 2D one. */
export function createCompositor(
	canvas: HTMLCanvasElement | OffscreenCanvas,
	want: CompositorKind | "auto",
): Compositor {
	if (want !== "canvas2d") {
		try {
			return new GLCompositor(canvas);
		} catch (err) {
			if (want === "webgl2") throw err;
		}
	}
	return new Canvas2DCompositor(canvas);
}
