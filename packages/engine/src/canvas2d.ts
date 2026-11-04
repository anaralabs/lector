// Canvas 2D compositor for machines without a usable GPU: tiles arrive baked (gamma, dark tone) as ImageBitmaps from the raster workers.

import { bakePixels, byte } from "./bake";
import type { Blend, Compositor, Tone } from "./gl";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Surface = OffscreenCanvas | HTMLCanvasElement;

interface Bitmap {
	w: number;
	h: number;
	/** what is drawn: a baked tile as it arrived, or `plain` for a raw one */
	src: ImageBitmap | Surface;
	/** raw tiles (not baked by a worker) are toned here, lazily */
	raw: boolean;
	toned: Surface | null;
	toneKey: string;
}

const OP: Record<Blend, GlobalCompositeOperation> = { none: "source-over", alpha: "source-over", multiply: "multiply", lighten: "lighten" };

function surface(w: number, h: number): Surface {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c;
}

const context2d = (c: Surface) => c.getContext("2d", { willReadFrequently: true }) as Ctx;

export class Canvas2DCompositor implements Compositor {
	readonly kind = "canvas2d" as const;
	private ctx: Ctx;
	private tone: Tone | null = null;
	private toneKey = "";
	private w = 1;
	private h = 1;
	private clipped = false;
	private styles = new Map<string, string>();
	textureBytes = 0;
	lost = false;
	onLost: () => void = () => {};
	onRestored: () => void = () => {};
	private ac = new AbortController();

	constructor(readonly canvas: Canvas) {
		const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true }) as Ctx | null;
		if (!ctx) throw new Error("Canvas 2D is not available");
		this.ctx = ctx;
		const target = canvas as EventTarget;
		// Accelerated 2D canvases can be lost too: tile bitmaps survive, only the target is redrawn.
		target.addEventListener(
			"contextlost",
			() => {
				this.lost = true;
				this.onLost();
			},
			{ signal: this.ac.signal },
		);
		target.addEventListener(
			"contextrestored",
			() => {
				this.lost = false;
				this.onRestored();
			},
			{ signal: this.ac.signal },
		);
	}

	dispose() {
		this.ac.abort();
		this.textureBytes = 0;
	}

	resize(w: number, h: number) {
		if (this.canvas.width !== w) this.canvas.width = w;
		if (this.canvas.height !== h) this.canvas.height = h;
		this.w = w;
		this.h = h;
		this.clipped = false;
	}

	upload(pixels: Uint8Array | ImageBitmap, w: number, h: number, gamma = 1, baked = false): Bitmap | null {
		this.textureBytes += w * h * 4;
		if (baked && !(pixels instanceof Uint8Array)) return { w, h, src: pixels, raw: false, toned: null, toneKey: "" };
		const plain = surface(w, h);
		const ctx = context2d(plain);
		let data: ImageData;
		if (pixels instanceof Uint8Array) data = new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, w * h * 4), w, h);
		else {
			ctx.drawImage(pixels, 0, 0);
			data = ctx.getImageData(0, 0, w, h);
		}
		if (!baked) bakePixels(data.data, w, h, gamma, null);
		ctx.putImageData(data, 0, 0);
		return { w, h, src: plain, raw: !baked, toned: null, toneKey: "" };
	}

	private scratch: Ctx | null = null;

	// A transferred bitmap is materialised on first use (~0.3ms per tile); a 1x1 draw does it between frames.
	warm(pixels: ImageBitmap) {
		this.scratch ??= context2d(surface(1, 1));
		this.scratch.drawImage(pixels, 0, 0, 1, 1);
	}

	// ImageBitmaps are not closed here: the tile cache may still be encoding one, and GC frees them.
	free(tex: unknown, w: number, h: number) {
		const b = tex as Bitmap;
		this.textureBytes -= w * h * 4 * (b.toned ? 2 : 1);
		if (!(b.src instanceof ImageBitmap)) b.src.width = b.src.height = 0;
		if (b.toned) b.toned.width = b.toned.height = 0;
		b.toned = null;
	}

	private toned(b: Bitmap, tone: Tone) {
		if (b.toned && b.toneKey === this.toneKey) return b.toned;
		const src = context2d(b.src as Surface).getImageData(0, 0, b.w, b.h);
		bakePixels(src.data, b.w, b.h, 1, [...tone.paper, ...tone.ink]);
		if (!b.toned) {
			b.toned = surface(b.w, b.h);
			this.textureBytes += b.w * b.h * 4;
		}
		context2d(b.toned).putImageData(src, 0, 0);
		b.toneKey = this.toneKey;
		return b.toned;
	}

	private style(c: readonly number[], alpha: boolean) {
		const key = `${c[0]},${c[1]},${c[2]},${alpha ? c[3] : 1}`;
		let s = this.styles.get(key);
		if (!s) {
			s = `rgba(${byte(c[0]!)},${byte(c[1]!)},${byte(c[2]!)},${alpha ? c[3] : 1})`;
			if (this.styles.size > 256) this.styles.clear();
			this.styles.set(key, s);
		}
		return s;
	}

	begin(clear: [number, number, number]) {
		const ctx = this.ctx;
		if (this.clipped) {
			ctx.restore();
			this.clipped = false;
		}
		ctx.globalCompositeOperation = "source-over";
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "low";
		ctx.fillStyle = this.style(clear, false);
		ctx.fillRect(0, 0, this.w, this.h);
	}

	setTone(tone: Tone | null) {
		this.tone = tone;
		this.toneKey = tone ? `${tone.paper.join()}|${tone.ink.join()}` : "";
	}

	clip(r: { x: number; y: number; w: number; h: number } | null) {
		const ctx = this.ctx;
		if (this.clipped) {
			ctx.restore();
			this.clipped = false;
		}
		if (!r) return;
		ctx.save();
		ctx.beginPath();
		const x = Math.max(0, Math.floor(r.x));
		const y = Math.max(0, Math.floor(r.y));
		ctx.rect(x, y, Math.max(0, Math.ceil(r.x + r.w) - x), Math.max(0, Math.ceil(r.y + r.h) - y));
		ctx.clip();
		this.clipped = true;
	}

	resetState() {}

	clipRects(rects: { x: number; y: number; w: number; h: number }[] | null) {
		const ctx = this.ctx;
		if (this.clipped) {
			ctx.restore();
			this.clipped = false;
		}
		if (!rects) return;
		ctx.save();
		ctx.beginPath();
		for (const r of rects) ctx.rect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.w) + 1, Math.ceil(r.h) + 1);
		ctx.clip();
		this.clipped = true;
	}

	drawTexture(tex: unknown, x: number, y: number, w: number, h: number, _gamma: number) {
		const b = tex as Bitmap;
		const ctx = this.ctx;
		ctx.globalCompositeOperation = "source-over";
		const src = b.raw && this.tone ? this.toned(b, this.tone) : b.src;
		// An unscaled blit is a row copy; any size change takes the much slower filtering path.
		if (Math.abs(w - b.w) < 0.5 && Math.abs(h - b.h) < 0.5) {
			ctx.drawImage(src, Math.round(x), Math.round(y));
			return;
		}
		// Only the on-screen part: a zoomed-in fallback can be many times the canvas.
		const cx0 = Math.max(0, x);
		const cy0 = Math.max(0, y);
		const cx1 = Math.min(this.w, x + w);
		const cy1 = Math.min(this.h, y + h);
		if (cx1 <= cx0 || cy1 <= cy0) return;
		const kx = b.w / w;
		const ky = b.h / h;
		ctx.drawImage(src, (cx0 - x) * kx, (cy0 - y) * ky, (cx1 - cx0) * kx, (cy1 - cy0) * ky, cx0, cy0, cx1 - cx0, cy1 - cy0);
	}

	drawRect(x: number, y: number, w: number, h: number, color: readonly [number, number, number, number], blend: Blend = "none") {
		const ctx = this.ctx;
		ctx.globalCompositeOperation = OP[blend];
		ctx.fillStyle = this.style(color, blend === "alpha");
		ctx.fillRect(x, y, w, h);
	}

	drawCircle(cx: number, cy: number, r: number, color: readonly [number, number, number, number]) {
		const ctx = this.ctx;
		ctx.globalCompositeOperation = "source-over";
		ctx.fillStyle = this.style(color, true);
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fill();
	}
}
