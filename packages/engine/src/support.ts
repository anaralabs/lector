// Feature detection. The engine needs WebGL2, WebAssembly and module workers;
// below that a host should fall back to another viewer (e.g. @anaralabs/lector).
// Minimum browsers: Chrome/Edge 80, Firefox 114, Safari / iOS Safari 15.

export type EngineFeature =
	| "webgl2"
	| "wasm"
	| "module-workers"
	| "message-channel"
	| "resize-observer"
	| "pointer-events";

export interface EngineSupport {
	supported: boolean;
	/** what is missing; empty when supported */
	missing: EngineFeature[];
	/** WebGL2 also works on an OffscreenCanvas, so the compositor can run in a worker */
	offscreen: boolean;
}

let cached: EngineSupport | null = null;

function moduleWorkers(): boolean {
	if (typeof Worker === "undefined") return false;
	// The options dictionary is read before the URL is parsed, so an invalid
	// URL tells us whether `type` is understood without starting a worker.
	let supported = false;
	try {
		new Worker("blob://", {
			get type() {
				supported = true;
				return "module" as const;
			},
		}).terminate();
	} catch {
		// expected: the URL is invalid
	}
	return supported;
}

function webgl2(canvas: HTMLCanvasElement | OffscreenCanvas): boolean {
	try {
		const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
		if (!gl) return false;
		// Give the context back now instead of waiting for GC (browsers cap live contexts).
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return true;
	} catch {
		return false;
	}
}

/**
 * What this browser supports. Synchronous and cached; the only work it does is
 * create (and immediately release) a throwaway WebGL2 context or two.
 */
export function getEngineSupport(): EngineSupport {
	if (cached) return cached;
	const missing: EngineFeature[] = [];
	const hasDom = typeof document !== "undefined";
	if (!hasDom || typeof WebGL2RenderingContext === "undefined" || !webgl2(document.createElement("canvas"))) missing.push("webgl2");
	if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") missing.push("wasm");
	if (!moduleWorkers()) missing.push("module-workers");
	if (typeof MessageChannel === "undefined") missing.push("message-channel");
	if (typeof ResizeObserver === "undefined") missing.push("resize-observer");
	if (typeof PointerEvent === "undefined") missing.push("pointer-events");
	// Safari 16.4-16.x has OffscreenCanvas and transferControlToOffscreen but
	// no WebGL on it, so probe the context rather than the constructor.
	const offscreen =
		missing.length === 0 &&
		typeof OffscreenCanvas !== "undefined" &&
		typeof HTMLCanvasElement !== "undefined" &&
		typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function" &&
		webgl2(new OffscreenCanvas(1, 1));
	cached = { supported: missing.length === 0, missing, offscreen };
	return cached;
}

/** True when `createViewer` can run here. Sync and cheap (cached after the first call). */
export function isEngineSupported(): boolean {
	return getEngineSupport().supported;
}
