/**
 * Pool of reusable HTMLCanvasElement scratch buffers.
 *
 * PDF page rendering creates and discards a temporary canvas for every
 * cache-miss render. On a long scroll session this causes hundreds of
 * canvas allocations and GC pressure. The pool keeps a small number of
 * canvases alive and reuses them, trading a tiny amount of memory for
 * significantly fewer allocations.
 *
 * Usage:
 *   const canvas = canvasPool.acquire(w, h);
 *   // ... render into canvas ...
 *   canvasPool.release(canvas);
 */
class CanvasPool {
	private pool: HTMLCanvasElement[] = [];
	private readonly maxSize: number;

	constructor(maxSize = 6) {
		this.maxSize = maxSize;
	}

	acquire(width: number, height: number): HTMLCanvasElement {
		const canvas = this.pool.pop() ?? document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}

	release(canvas: HTMLCanvasElement): void {
		if (this.pool.length < this.maxSize) {
			// Keep the canvas alive but reset to minimal size to free GPU memory
			// while holding the JS object reference for the next acquire.
			canvas.width = 1;
			canvas.height = 1;
			this.pool.push(canvas);
		} else {
			// Pool is full — zero both dimensions to release GPU-backed memory
			// (important for Safari which has a 384 MB total canvas limit).
			canvas.width = 0;
			canvas.height = 0;
		}
	}
}

export const canvasPool = new CanvasPool(6);
