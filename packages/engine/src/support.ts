// Feature detection: WebGL2 on a hardware GPU composites, anything else uses Canvas 2D. Chrome 80, Firefox 114, Safari 15.

import type { CompositorKind } from "./gl";

export type EngineFeature =
	| "webgl2"
	| "canvas2d"
	| "wasm"
	| "module-workers"
	| "message-channel"
	| "resize-observer"
	| "pointer-events";

export interface EngineSupport {
	supported: boolean;
	/** what is missing; empty when supported */
	missing: EngineFeature[];
	/** the compositor `auto` picks: webgl2 on a hardware GPU, canvas2d without WebGL2 or on a software rasteriser */
	compositor: CompositorKind;
	/** WebGL2 works here, even if only in software */
	webgl2: boolean;
	/** unmasked WebGL renderer string, when the browser exposes it */
	renderer: string | null;
	/** WebGL2 runs on a CPU rasteriser (SwiftShader, WARP / Basic Render Driver, llvmpipe) */
	softwareGL: boolean;
	/** the chosen compositor also works on an OffscreenCanvas, so it can run in a worker */
	offscreen: boolean;
	/** per compositor, for hosts that force one */
	offscreenBy: Record<CompositorKind, boolean>;
}

let cached: EngineSupport | null = null;

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|\bwarp\b|software/i;

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

function probeWebgl2(canvas: HTMLCanvasElement | OffscreenCanvas): { ok: boolean; renderer: string | null } {
	try {
		const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
		if (!gl) return { ok: false, renderer: null };
		const info = gl.getExtension("WEBGL_debug_renderer_info");
		const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "") || null;
		// Give the context back now instead of waiting for GC (browsers cap live contexts).
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return { ok: true, renderer };
	} catch {
		return { ok: false, renderer: null };
	}
}

function canvas2d(canvas: HTMLCanvasElement | OffscreenCanvas): boolean {
	try {
		return !!canvas.getContext("2d");
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
	const gl = hasDom && typeof WebGL2RenderingContext !== "undefined" ? probeWebgl2(document.createElement("canvas")) : { ok: false, renderer: null };
	const has2d = hasDom && canvas2d(document.createElement("canvas"));
	if (!gl.ok && !has2d) missing.push("canvas2d");
	if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") missing.push("wasm");
	if (!moduleWorkers()) missing.push("module-workers");
	if (typeof MessageChannel === "undefined") missing.push("message-channel");
	if (typeof ResizeObserver === "undefined") missing.push("resize-observer");
	if (typeof PointerEvent === "undefined") missing.push("pointer-events");
	const softwareGL = gl.ok && !!gl.renderer && SOFTWARE_GL.test(gl.renderer);
	const compositor: CompositorKind = gl.ok && !softwareGL ? "webgl2" : "canvas2d";
	// Safari 16.4-16.x has OffscreenCanvas and transferControlToOffscreen but
	// no WebGL on it, so probe the context rather than the constructor.
	const transferable =
		missing.length === 0 &&
		typeof OffscreenCanvas !== "undefined" &&
		typeof HTMLCanvasElement !== "undefined" &&
		typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function";
	const offscreenBy = {
		webgl2: transferable && gl.ok && probeWebgl2(new OffscreenCanvas(1, 1)).ok,
		canvas2d: transferable && canvas2d(new OffscreenCanvas(1, 1)),
	};
	cached = { supported: missing.length === 0, missing, compositor, webgl2: gl.ok, renderer: gl.renderer, softwareGL, offscreen: offscreenBy[compositor], offscreenBy };
	return cached;
}

/** True when `createViewer` can run here. Sync and cheap (cached after the first call). */
export function isEngineSupported(): boolean {
	return getEngineSupport().supported;
}
