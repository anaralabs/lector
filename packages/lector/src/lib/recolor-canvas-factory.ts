import type { RenderColorMap } from "./dark-mode";
import { applyContextRecolor, removeContextRecolor } from "./recolor-context";

export interface RenderColorMapRef {
	current: RenderColorMap | null;
}

interface CanvasAndContext {
	canvas: HTMLCanvasElement | null;
	context: CanvasRenderingContext2D | null;
}

/**
 * pdf.js paints transparency groups, soft masks, tiling/shading patterns and
 * image-mask fills on internal scratch canvases obtained from the document's
 * CanvasFactory — that content never touches the context we hand to
 * `page.render()`. Passing this factory via getDocument's `CanvasFactory`
 * option extends dark-mode recoloring to those canvases, which is what makes
 * the scheme complete (pages with a page-level transparency group otherwise
 * render entirely on a scratch canvas).
 *
 * The map is captured per canvas at creation time from `mapRef`; scratch
 * canvases only live for a single render task, so toggling the scheme simply
 * takes effect on the next render.
 */
export function createRecolorCanvasFactory(mapRef: RenderColorMapRef) {
	return class RecolorCanvasFactory {
		#document: Document;
		#enableHWA: boolean;

		constructor({
			ownerDocument = globalThis.document,
			enableHWA = false,
		}: { ownerDocument?: Document; enableHWA?: boolean } = {}) {
			this.#document = ownerDocument;
			this.#enableHWA = enableHWA;
		}

		create(width: number, height: number): CanvasAndContext {
			if (width <= 0 || height <= 0) {
				throw new Error("Invalid canvas size");
			}
			const canvas = this.#document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d", {
				willReadFrequently: !this.#enableHWA,
			});
			const map = mapRef.current;
			if (context && map) {
				applyContextRecolor(context, map);
			}
			return { canvas, context };
		}

		reset(canvasAndContext: CanvasAndContext, width: number, height: number) {
			if (!canvasAndContext.canvas) {
				throw new Error("Canvas is not specified");
			}
			if (width <= 0 || height <= 0) {
				throw new Error("Invalid canvas size");
			}
			canvasAndContext.canvas.width = width;
			canvasAndContext.canvas.height = height;
			// pdf.js scratch canvases live within a single render task today,
			// but the factory contract allows reuse via reset — re-sync the
			// wrapper with the current scheme so a reused context never keeps
			// a stale map.
			if (canvasAndContext.context) {
				const map = mapRef.current;
				if (map) applyContextRecolor(canvasAndContext.context, map);
				else removeContextRecolor(canvasAndContext.context);
			}
		}

		destroy(canvasAndContext: CanvasAndContext) {
			if (!canvasAndContext.canvas) {
				throw new Error("Canvas is not specified");
			}
			canvasAndContext.canvas.width = 0;
			canvasAndContext.canvas.height = 0;
			canvasAndContext.canvas = null;
			canvasAndContext.context = null;
		}
	};
}
