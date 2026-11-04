import { Canvas2DCompositor } from "./canvas2d";
import { type Compositor, type CompositorKind, GLCompositor } from "./gl";

/** `want`, or 2D when WebGL2 fails here and `fallback` allows it (a canvas whose WebGL2 context fails can still take a 2D one). */
export function createCompositor(canvas: HTMLCanvasElement | OffscreenCanvas, want: CompositorKind | "auto", fallback = want === "auto"): Compositor {
	if (want !== "canvas2d") {
		try {
			return new GLCompositor(canvas);
		} catch (err) {
			if (!fallback) throw err;
		}
	}
	return new Canvas2DCompositor(canvas);
}
