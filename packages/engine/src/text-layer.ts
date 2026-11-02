// Hidden DOM text for screen readers and the browser's find (Cmd/Ctrl+F).
// Transparent, unselectable, click-through spans positioned from PDFium's char
// boxes, one per text line, for the visible pages ±1 only. One transform on
// the root follows the camera, so scrolling and zooming never touch layout.

import type { Camera } from "./core";
import type { Rect } from "./text";

/** One line of a page's text layer, in page points (top-left origin). */
export interface TextLayerLine {
	text: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** right-to-left run (bidi), or a vertical line (CJK) */
	dir?: "rtl" | "ttb";
}

const KEEP_PAGES = 12;
const MEASURE_PX = 100;
const FONT = "sans-serif";
const EM_PER_BOX = 0.86;

export class TextLayer {
	readonly root: HTMLDivElement;
	private layout: Rect[] = [];
	private cam: Camera = { x: 0, y: 0, zoom: 1 };
	private vw = 0;
	private vh = 0;
	private shown = new Map<number, HTMLElement>();
	private cache = new Map<number, TextLayerLine[] | Promise<TextLayerLine[]>>();
	private want: number[] = [];
	private scheduled = false;
	private measure: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
	private destroyed = false;

	constructor(
		container: HTMLElement,
		private load: (page: number) => Promise<TextLayerLine[]>,
		label = "PDF document",
	) {
		const root = document.createElement("div");
		root.setAttribute("role", "document");
		root.setAttribute("aria-label", label);
		root.className = "lector-text-layer";
		// Above the canvas so the browser's find highlights show, but never hit:
		// the GPU selection owns all pointer input.
		root.style.cssText =
			"position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;pointer-events:none;user-select:none;-webkit-user-select:none;color:transparent;white-space:pre;line-height:1;z-index:1;will-change:transform;";
		root.style.fontFamily = FONT;
		container.appendChild(root);
		this.root = root;
	}

	setLayout(layout: Rect[]) {
		this.layout = layout;
		for (const el of this.shown.values()) el.remove();
		this.shown.clear();
		this.cache.clear();
		this.update();
	}

	setViewport(w: number, h: number) {
		this.vw = w;
		this.vh = h;
		this.update();
	}

	setCamera(cam: Camera) {
		this.cam = cam;
		const z = cam.zoom;
		// The only per-frame write: a compositor-only transform.
		this.root.style.transform = `matrix(${z},0,0,${z},${-cam.x * z},${-cam.y * z})`;
		this.update();
	}

	/** Pages whose text is in the DOM (visible ±1). */
	get pages() {
		return [...this.shown.keys()].sort((a, b) => a - b);
	}

	private visible(): number[] {
		const { layout, cam } = this;
		if (!layout.length || !this.vh) return [];
		const y0 = cam.y;
		const y1 = cam.y + this.vh / cam.zoom;
		let lo = 0;
		let hi = layout.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (layout[mid]!.y <= y0) lo = mid;
			else hi = mid - 1;
		}
		const out: number[] = [];
		if (lo > 0) out.push(lo - 1);
		let p = lo;
		for (; p < layout.length && layout[p]!.y <= y1; p++) out.push(p);
		if (p < layout.length) out.push(p);
		return out;
	}

	private update() {
		const want = this.visible();
		if (want.length === this.want.length && want.every((p, i) => p === this.want[i])) return;
		this.want = want;
		if (this.scheduled) return;
		this.scheduled = true;
		// DOM work happens off the input path: after the frame, in idle time if possible.
		const run = () => {
			this.scheduled = false;
			void this.sync();
		};
		if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 150 });
		else setTimeout(run, 50);
	}

	private async sync() {
		if (this.destroyed) return;
		const want = new Set(this.want);
		for (const [p, el] of this.shown) {
			if (want.has(p)) continue;
			el.remove();
			this.shown.delete(p);
		}
		for (const p of this.want) {
			if (this.shown.has(p)) continue;
			const lines = await this.lines(p);
			if (this.destroyed || !this.want.includes(p) || this.shown.has(p)) continue;
			const el = this.build(p, lines);
			// Keep DOM order = page order, for reading order.
			const next = [...this.shown.entries()].filter(([q]) => q > p).sort((a, b) => a[0] - b[0])[0];
			this.root.insertBefore(el, next ? next[1] : null);
			this.shown.set(p, el);
		}
	}

	private lines(page: number): Promise<TextLayerLine[]> {
		const hit = this.cache.get(page);
		if (hit) return Promise.resolve(hit);
		const p = this.load(page).catch(() => []);
		this.cache.set(page, p);
		p.then((lines) => {
			this.cache.delete(page);
			this.cache.set(page, lines);
			while (this.cache.size > KEEP_PAGES) this.cache.delete(this.cache.keys().next().value!);
		});
		return p;
	}

	private width(text: string) {
		if (!this.measure) {
			const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
			this.measure = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
			this.measure.font = `${MEASURE_PX}px ${FONT}`;
		}
		return this.measure.measureText(text).width;
	}

	private build(page: number, lines: TextLayerLine[]) {
		const r = this.layout[page]!;
		const section = document.createElement("section");
		section.setAttribute("role", "region");
		section.setAttribute("aria-label", `Page ${page + 1}`);
		section.dataset.page = String(page);
		section.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
		const frag = document.createDocumentFragment();
		for (const line of lines) {
			const text = line.text;
			if (!text.trim()) continue;
			const span = document.createElement("span");
			span.textContent = text;
			const vertical = line.dir === "ttb";
			// Font size from the line box; stretch the run to the box's length.
			// PDFium's loose boxes span ascent to descent; a CSS em box of that
			// size draws glyphs low, so size it a bit below the box.
			const size = (vertical ? line.w : line.h) * EM_PER_BOX;
			const length = vertical ? line.h : line.w;
			const natural = (this.width(text) * size) / MEASURE_PX;
			const k = natural > 0 ? length / natural : 1;
			const inset = ((vertical ? line.w : line.h) - size) / 2;
			const left = vertical ? line.x + inset : line.x;
			const top = vertical ? line.y : line.y + inset;
			let css = `position:absolute;left:${left}px;top:${top}px;font-size:${size}px;transform-origin:0 0;`;
			if (vertical) css += `writing-mode:vertical-rl;transform:scaleY(${k});`;
			else css += `transform:scaleX(${k});`;
			if (line.dir === "rtl") span.dir = "rtl";
			span.style.cssText = css;
			frag.appendChild(span);
			// Separate lines for screen readers and find (no words glued across lines).
			frag.appendChild(document.createTextNode("\n"));
		}
		section.appendChild(frag);
		return section;
	}

	destroy() {
		this.destroyed = true;
		this.root.remove();
		this.shown.clear();
		this.cache.clear();
	}
}
