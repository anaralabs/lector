/// <reference lib="webworker" />
// Runs the viewer core off the main thread: the canvas is an OffscreenCanvas,
// so host-page work (React renders, layout) cannot delay a frame.

import { type CoreOptions, ViewerCore } from "./core";
import { type CoreInput, type CoreReply, replayInput } from "./core-input";

type Msg =
	| { t: "init"; canvas: OffscreenCanvas; ports: MessagePort[]; options: Partial<CoreOptions>; debug?: boolean; software?: boolean }
	/** the viewer is destroyed: free GPU resources and ports, then exit */
	| { t: "dispose" }
	| CoreInput;

let core: ViewerCore | null = null;
const pending: CoreInput[] = [];

const raf: (cb: (t: number) => void) => void =
	typeof self.requestAnimationFrame === "function"
		? (cb) => self.requestAnimationFrame(cb)
		: (cb) => setTimeout(() => cb(performance.now()), 1000 / 120);

const reply = (m: CoreReply, transfer: Transferable[] = []) => self.postMessage(m, transfer);

reply({ t: "boot" });

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
			core = new ViewerCore(m.canvas, m.ports, (e) => self.postMessage(e), raf, m.options, m.software);
			// Debugging and benches only (the viewer passes globalThis.__lectorEngineDebug).
			if (m.debug) (self as unknown as { __core: ViewerCore }).__core = core;
		} catch (err) {
			// The ports are still unused: the viewer starts the core on a main-thread canvas with them.
			self.onmessage = null;
			pending.length = 0;
			reply({ t: "core-failed", reason: String((err as Error)?.message ?? err), ports: m.ports }, m.ports);
			return;
		}
		reply({ t: "core-started" });
		for (const p of pending.splice(0)) replayInput(core, p);
		return;
	}
	if (!core) pending.push(m);
	else replayInput(core, m);
};
