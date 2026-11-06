// Motion policy for the CPU (Canvas 2D) compositor: cheaper frames while the camera moves, full detail once it rests.

/** a motion frame slower than this missed a 60Hz vsync */
export const LATE_FRAME_MS = 25;
/** motion frames remembered */
const WINDOW = 30;
/** late frames in the window that engage low-resolution motion */
const LATE_TO_ENGAGE = 6;
/** the camera counts as moving this long after its last change */
export const MOVE_SETTLE_MS = 120;

export type AdaptiveMode = "auto" | boolean;

/**
 * Low-resolution motion engages for good once motion frames keep missing 60Hz
 * (`adaptive: "auto"`), or from the start (`adaptive: true`, or `auto` without a GPU).
 */
export class MotionPolicy {
	low: boolean;
	private late: boolean[] = [];
	private readonly mode: AdaptiveMode;

	constructor(mode: AdaptiveMode, software = false) {
		this.mode = mode;
		this.low = mode === true || (mode === "auto" && software);
	}

	/** how late a frame after one that moved the camera was (from the previous frame, or from the input that asked for it) */
	observe(ms: number) {
		if (this.low || this.mode === false) return;
		this.late.push(ms > LATE_FRAME_MS);
		if (this.late.length > WINDOW) this.late.shift();
		if (this.late.filter(Boolean).length >= LATE_TO_ENGAGE) {
			this.low = true;
			this.late = [];
		}
	}
}

/** Device pixels per CSS pixel to draw and raster at: 1x while a low-resolution motion lasts, `dpr` otherwise. */
export function motionScale(dpr: number, low: boolean, moving: boolean) {
	return low && moving ? Math.min(dpr, 1) : dpr;
}
