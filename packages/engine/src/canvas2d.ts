// Canvas 2D compositor for machines without a usable GPU; gamma and the dark tone curve are baked into each tile.

import type { Blend, Compositor, Tone } from "./gl";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Bitmap {
	w: number;
	h: number;
	/** gamma-corrected page pixels */
	plain: OffscreenCanvas | HTMLCanvasElement;
	toned: OffscreenCanvas | HTMLCanvasElement | null;
	toneKey: string;
}

const OP: Record<Blend, GlobalCompositeOperation> = {
	none: "source-over",
	alpha: "source-over",
	multiply: "multiply",
	lighten: "lighten",
};

function surface(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c;
}

function context2d(c: OffscreenCanvas | HTMLCanvasElement) {
	return c.getContext("2d", { willReadFrequently: true }) as Ctx;
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export class Canvas2DCompositor implements Compositor {
	readonly kind = "canvas2d" as const;
	private ctx: Ctx;
	private tone: Tone | null = null;
	private toneKey = "";
	private w = 1;
	private h = 1;
	private clipped = false;
	private styles = new Map<string, string>();
	private lut: { gamma: number; table: Uint8Array } | null = null;
	textureBytes = 0;
	lost = false;
	onLost: () => void = () => {};
	onRestored: () => void = () => {};
	private ac = new AbortController();

	constructor(readonly canvas: Canvas) {
		const ctx = canvas.getContext("2d", {
			alpha: false,
			desynchronized: true,
		}) as Ctx | null;
		if (!ctx) throw new Error("Canvas 2D is not available");
		this.ctx = ctx;
		const target = canvas as EventTarget;
		// Accelerated 2D canvases can be lost too (Chrome): every tile bitmap survives, only the target is redrawn.
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

	private gammaTable(gamma: number) {
		if (this.lut?.gamma === gamma) return this.lut.table;
		const table = new Uint8Array(256);
		for (let i = 0; i < 256; i++) table[i] = byte((i / 255) ** gamma);
		this.lut = { gamma, table };
		return table;
	}

	upload(
		pixels: Uint8Array | ImageBitmap,
		w: number,
		h: number,
		gamma = 1,
	): Bitmap | null {
		const plain = surface(w, h);
		const ctx = context2d(plain);
		let data: ImageData;
		if (pixels instanceof Uint8Array)
			data = new ImageData(
				new Uint8ClampedArray(
					pixels.buffer as ArrayBuffer,
					pixels.byteOffset,
					w * h * 4,
				),
				w,
				h,
			);
		else {
			ctx.drawImage(pixels, 0, 0);
			data = ctx.getImageData(0, 0, w, h);
		}
		if (gamma !== 1) {
			const t = this.gammaTable(gamma);
			const d = data.data;
			for (let i = 0; i < d.length; i += 4) {
				d[i] = t[d[i]!]!;
				d[i + 1] = t[d[i + 1]!]!;
				d[i + 2] = t[d[i + 2]!]!;
			}
		}
		ctx.putImageData(data, 0, 0);
		this.textureBytes += w * h * 4;
		return { w, h, plain, toned: null, toneKey: "" };
	}

	free(tex: unknown, w: number, h: number) {
		const b = tex as Bitmap;
		this.textureBytes -= w * h * 4 * (b.toned ? 2 : 1);
		b.plain.width = b.plain.height = 0;
		if (b.toned) b.toned.width = b.toned.height = 0;
		b.toned = null;
	}

	/** Same curve as the WebGL shader's dark branch, applied to a copy of the tile. */
	private toned(b: Bitmap, tone: Tone) {
		if (b.toned && b.toneKey === this.toneKey) return b.toned;
		const src = context2d(b.plain).getImageData(0, 0, b.w, b.h);
		const d = src.data;
		const [pr, pg, pb] = tone.paper;
		const [ir, ig, ib] = tone.ink;
		for (let i = 0; i < d.length; i += 4) {
			const r = d[i]! / 255;
			const g = d[i + 1]! / 255;
			const bl = d[i + 2]! / 255;
			const l = 0.299 * r + 0.587 * g + 0.114 * bl;
			const t = 1 - l;
			d[i] = byte(pr + (ir - pr) * t + (r - l) * 0.8);
			d[i + 1] = byte(pg + (ig - pg) * t + (g - l) * 0.8);
			d[i + 2] = byte(pb + (ib - pb) * t + (bl - l) * 0.8);
		}
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
		ctx.rect(
			x,
			y,
			Math.max(0, Math.ceil(r.x + r.w) - x),
			Math.max(0, Math.ceil(r.y + r.h) - y),
		);
		ctx.clip();
		this.clipped = true;
	}

	resetState() {}

	drawTexture(
		tex: unknown,
		x: number,
		y: number,
		w: number,
		h: number,
		_gamma: number,
	) {
		const b = tex as Bitmap;
		const ctx = this.ctx;
		ctx.globalCompositeOperation = "source-over";
		const src = this.tone ? this.toned(b, this.tone) : b.plain;
		// An unscaled blit is a row copy; any size change takes the (much slower) filtering path.
		if (Math.abs(w - b.w) < 0.5 && Math.abs(h - b.h) < 0.5)
			ctx.drawImage(src, Math.round(x), Math.round(y));
		else ctx.drawImage(src, x, y, w, h);
	}

	drawRect(
		x: number,
		y: number,
		w: number,
		h: number,
		color: readonly [number, number, number, number],
		blend: Blend = "none",
	) {
		const ctx = this.ctx;
		ctx.globalCompositeOperation = OP[blend];
		ctx.fillStyle = this.style(color, blend === "alpha");
		ctx.fillRect(x, y, w, h);
	}

	drawCircle(
		cx: number,
		cy: number,
		r: number,
		color: readonly [number, number, number, number],
	) {
		const ctx = this.ctx;
		ctx.globalCompositeOperation = "source-over";
		ctx.fillStyle = this.style(color, true);
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fill();
	}
}
