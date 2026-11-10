import type { Command, InputMsg, ViewerCore } from "./core";

/** What the viewer sends a running core, in the compositor worker or on the main thread. */
export type CoreInput =
	| { t: "input"; msg: InputMsg }
	| { t: "command"; cmd: Command }
	/** a fresh canvas after the WebGL context was lost for good */
	| { t: "canvas"; canvas: OffscreenCanvas }
	| { t: "canvas-failed"; reason: string }
	| { t: "hidden"; hidden: boolean };

/** What the compositor worker tells the viewer besides core events. */
export type CoreReply =
	| { t: "boot" }
	| { t: "core-started" }
	/** the compositor could not start in the worker; its unused raster ports come back */
	| { t: "core-failed"; reason: string; ports: MessagePort[] };

export function replayInput(core: ViewerCore, m: CoreInput) {
	if (m.t === "canvas") core.swapCanvas(m.canvas);
	else if (m.t === "canvas-failed") core.canvasFailed(m.reason);
	else if (m.t === "hidden") core.setHidden(m.hidden);
	else if (m.t === "input") core.handle(m.msg);
	else core.command(m.cmd);
}
