/// <reference lib="webworker" />
// Runs the viewer core off the main thread: the canvas is an OffscreenCanvas,
// so host-page work (React renders, layout) cannot delay a frame.

import { type Command, type CoreOptions, type InputMsg, ViewerCore } from "./core";

type Msg =
	| { t: "init"; canvas: OffscreenCanvas; ports: MessagePort[]; options: Partial<CoreOptions>; debug?: boolean }
	| { t: "input"; msg: InputMsg }
	| { t: "command"; cmd: Command }
	/** the viewer is destroyed: free GPU resources and ports, then exit */
	| { t: "dispose" };

let core: ViewerCore | null = null;
const pending: Msg[] = [];

const raf: (cb: (t: number) => void) => void =
	typeof self.requestAnimationFrame === "function"
		? (cb) => self.requestAnimationFrame(cb)
		: (cb) => setTimeout(() => cb(performance.now()), 1000 / 120);

self.postMessage({ t: "boot" });

self.onmessage = (ev: MessageEvent<Msg>) => {
	const m = ev.data;
	if (m.t === "dispose") {
		core?.dispose();
		core = null;
		pending.length = 0;
		self.close();
		return;
	}
	if (m.t === "init") {
		try {
			core = new ViewerCore(m.canvas, m.ports, (e) => self.postMessage(e), raf, m.options);
			// Debugging and benches only (the viewer passes globalThis.__lectorEngineDebug).
			if (m.debug) (self as unknown as { __core: ViewerCore }).__core = core;
		} catch (err) {
			self.postMessage({ type: "error", message: String((err as Error)?.message ?? err), code: "gpu", phase: "engine-load" });
			return;
		}
		for (const p of pending.splice(0)) dispatch(p);
		return;
	}
	if (!core) pending.push(m);
	else dispatch(m);
};

function dispatch(m: Msg) {
	if (m.t === "input") core!.handle(m.msg);
	else if (m.t === "command") core!.command(m.cmd);
}
