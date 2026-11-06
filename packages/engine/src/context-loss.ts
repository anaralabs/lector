// What the core does when its canvas context is lost: wait for the browser to restore it, then move to a fresh CPU-backed 2D canvas.

import type { Compositor } from "./gl";
import type { ErrorCode, ErrorPhase } from "./protocol";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const RESTORE_WAIT_MS = 1500;
/** fresh canvases one viewer may take; a GPU that keeps dropping them is given up on */
const MAX_SWAPS = 3;

const GPU_2D: CanvasRenderingContext2DSettings = { alpha: false, desynchronized: true };
// willReadFrequently keeps the canvas in CPU memory: it draws even while the GPU process is gone.
const CPU_2D: CanvasRenderingContext2DSettings = { alpha: false, willReadFrequently: true };

/** A 2D context for `canvas` (CPU-backed when `cpu`, or when the GPU one is refused), or an error saying why there is none. */
export function open2d(canvas: Canvas, cpu: boolean): { ctx: Ctx; cpu: boolean } {
	let reason = "";
	for (const settings of cpu ? [CPU_2D] : [GPU_2D, CPU_2D]) {
		try {
			const ctx = canvas.getContext("2d", settings) as Ctx | null;
			if (ctx && !(ctx as { isContextLost?: () => boolean }).isContextLost?.()) return { ctx, cpu: settings === CPU_2D };
			reason ||= ctx ? "the context was lost" : "getContext returned null";
		} catch (err) {
			reason ||= String((err as Error)?.message ?? err);
		}
	}
	throw new Error(`Canvas 2D is not available (${reason})`);
}

type RecoveryEvent =
	| { type: "error"; message: string; code: ErrorCode; phase: ErrorPhase }
	| { type: "need-canvas"; reason: "context-lost" };

interface Timers {
	set: (fn: () => void, ms: number) => unknown;
	clear: (t: unknown) => void;
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

export class ContextRecovery {
	private losses = 0;
	private swaps = 0;
	private failedSwaps = 0;
	private timer: unknown = null;
	/** the pending request goes out at once (a later loss event must not push it back) */
	private soon = false;
	private stopped = false;
	private emit: (e: RecoveryEvent) => void;
	private timers: Timers;

	constructor(emit: (e: RecoveryEvent) => void, timers: Timers = realTimers) {
		this.emit = emit;
		this.timers = timers;
	}

	/** Listens to `gl`'s loss and restore; a context that is already lost asks for a fresh canvas right away. */
	watch(gl: Compositor, onRestored: () => void) {
		gl.onLost = (cause) => this.lost(gl, cause);
		gl.onRestored = () => {
			this.cancel();
			onRestored();
		};
		if (gl.lost) this.request(0);
	}

	private lost(gl: Compositor, cause?: unknown) {
		const what = gl.kind === "webgl2" ? "WebGL" : "Canvas 2D";
		const message = cause
			? `lector-engine: the restored ${what} context could not be rebuilt (${String((cause as Error)?.message ?? cause)}); moving to Canvas 2D`
			: `lector-engine: the ${what} context was lost; waiting for the browser to restore it`;
		this.emit({ type: "error", message, code: "gpu", phase: "render" });
		// A second loss, a failed restore, or one the browser does not undo quickly means this GPU is not dependable.
		this.losses++;
		this.request(cause || this.losses > 1 ? 0 : RESTORE_WAIT_MS);
	}

	private request(ms: number) {
		if (this.stopped || (this.timer !== null && this.soon)) return;
		this.cancel();
		this.soon = ms === 0;
		this.timer = this.timers.set(() => {
			this.timer = null;
			this.soon = false;
			if (this.swaps >= MAX_SWAPS) this.fail(`gave up after ${MAX_SWAPS} canvases`);
			else this.emit({ type: "need-canvas", reason: "context-lost" });
		}, ms);
	}

	/** The compositor for the host's fresh canvas, or null: another canvas was asked for, or the switch failed for good (an error went out). */
	swap(canvas: Canvas, make: (canvas: Canvas) => Compositor): Compositor | null {
		this.cancel();
		if (this.stopped) return null;
		try {
			const next = make(canvas);
			this.swaps++;
			this.failedSwaps = 0;
			return next;
		} catch (err) {
			const reason = String((err as Error)?.message ?? err);
			if (++this.failedSwaps === 1 && this.swaps < MAX_SWAPS) this.emit({ type: "need-canvas", reason: "context-lost" });
			else this.fail(reason);
			return null;
		}
	}

	/** The host could not hand over a canvas: nothing can draw. */
	fail(reason: string) {
		this.cancel();
		if (this.stopped) return;
		this.stopped = true;
		this.emit({ type: "error", message: `lector-engine: Canvas 2D switch failed: ${reason}`, code: "compositor", phase: "render" });
	}

	private cancel() {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		this.soon = false;
	}

	dispose() {
		this.cancel();
		this.stopped = true;
	}
}
