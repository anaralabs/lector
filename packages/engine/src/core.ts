// The viewer core. It owns the camera, page layout, tile pyramid, text
// selection and the WebGL frame loop. It never touches the DOM, so the same
// code runs on the main thread or inside a worker with an OffscreenCanvas.

import { Compositor } from "./gl";
import type { Link, OutlineItem, PageSize } from "./protocol";
import { RasterPool, type TextResult, type TileResult } from "./raster-pool";
import { PageText, type Rect, type TextPoint, comparePoints } from "./text";

export type Color = [number, number, number, number];

export interface CoreOptions {
	/** viewport background (0-1 rgb) */
	background: [number, number, number];
	/** gap between pages in PDF points */
	pageGap: number;
	/** multiplied over the page under selected text */
	selectionColor: Color;
	/** dark mode: the paper under selected text becomes this (ink stays on top) */
	selectionColorDark: Color;
	/** default highlight colour (multiplied) */
	highlightColor: Color;
	/** >1 darkens anti-aliased glyph edges (PDFium renders thin text) */
	gamma: number;
	/** GPU texture budget for tiles */
	textureBudgetMB: number;
	initialZoom: "fit-width" | number;
	minZoom: number;
	maxZoom: number;
	/** dark mode: page white maps to `paper`, ink maps to `ink` */
	dark: boolean;
	paper: [number, number, number];
	ink: [number, number, number];
}

export const defaultOptions: CoreOptions = {
	background: [0.93, 0.93, 0.94],
	pageGap: 12,
	selectionColor: [0.62, 0.78, 1, 1],
	selectionColorDark: [0.16, 0.31, 0.58, 1],
	highlightColor: [1, 0.9, 0.4, 1],
	gamma: 1.25,
	textureBudgetMB: 384,
	initialZoom: "fit-width",
	minZoom: 0.1,
	maxZoom: 24,
	dark: false,
	paper: [0.12, 0.12, 0.13],
	ink: [0.88, 0.88, 0.86],
};

export type PointerKind = "mouse" | "touch" | "pen";

export type InputMsg =
	| { type: "resize"; w: number; h: number; dpr: number }
	| { type: "wheel"; x: number; y: number; dx: number; dy: number; ctrl: boolean; mode: number }
	| { type: "gesture"; phase: "start" | "change" | "end"; x: number; y: number; scale: number }
	| {
			type: "pointer";
			phase: "down" | "move" | "up" | "cancel";
			id: number;
			x: number;
			y: number;
			buttons: number;
			kind: PointerKind;
			clicks: number;
			shift: boolean;
	  }
	| { type: "key"; key: string; mod: boolean; shift: boolean }
	| { type: "leave" };

export interface Highlight {
	id: string;
	page: number;
	/** page points, top-left origin */
	rects: Rect[];
	color?: Color;
	/** fill (default), outline (2px border) or underline (2px bar at the rect's bottom) */
	style?: "fill" | "outline" | "underline";
	/** false: drawn but not hoverable/clickable (e.g. search hits) */
	interactive?: boolean;
}

export interface SearchHit {
	page: number;
	index: number;
	length: number;
	/** the match with some surrounding context */
	snippet: string;
	rects: Rect[];
}

export type Request =
	| { type: "search"; query: string; limit?: number }
	| { type: "outline" }
	| { type: "page-text"; page: number }
	| { type: "rects"; page: number; from: number; to: number }
	| { type: "thumbnail"; page: number; width: number };

export type Command =
	| { type: "zoom"; zoom: number; x?: number; y?: number }
	| { type: "fit-width" }
	| { type: "goto"; page: number; top?: number }
	/** scroll so that `rect` (page points) is centred, zooming out if it does not fit */
	| { type: "reveal"; page: number; rect: Rect }
	| { type: "request"; id: number; request: Request }
	| { type: "select"; page: number; from: number; to: number }
	| { type: "highlights"; items: Highlight[] }
	| { type: "clear-selection" }
	| { type: "options"; options: Partial<CoreOptions> };

export interface Stats {
	fps: number;
	p95FrameMs: number;
	worstFrameMs: number;
	avgCpuMs: number;
	tiles: number;
	textureMB: number;
	pendingJobs: number;
	avgTileMs: number;
	targetScale: number;
	workers: number;
}

export interface Camera {
	/** doc point at the viewport's top-left */
	x: number;
	y: number;
	zoom: number;
}

export interface SelectionInfo {
	text: string;
	/** per-page rects in page points (top-left origin) */
	pages: { page: number; rects: Rect[] }[];
	/** bounding box of the selection's last line, in viewport css px (for tooltips) */
	anchor: Rect | null;
}

export type Cursor = "default" | "text" | "pointer";

export type CoreEvent =
	| { type: "ready"; pages: PageSize[]; layout: Rect[] }
	| { type: "view"; zoom: number; page: number; pageCount: number }
	| { type: "camera"; camera: Camera; moving: boolean }
	| { type: "selection"; selection: SelectionInfo | null; final: boolean }
	| { type: "cursor"; cursor: Cursor }
	/** the canvas buffer now matches this css size (hosts size the element after this) */
	| { type: "resized"; w: number; h: number }
	| { type: "link"; url: string }
	| { type: "highlight-click"; id: string; screen: Rect }
	| { type: "highlight-hover"; id: string | null; screen: Rect | null }
	| { type: "click"; page: number; x: number; y: number }
	| { type: "response"; id: number; result: unknown }
	| { type: "stats"; stats: Stats }
	| { type: "error"; message: string };

interface Tile {
	key: string;
	page: number;
	scale: number;
	/** device-pixel rect within the page rendered at `scale` */
	x: number;
	y: number;
	w: number;
	h: number;
	tex: WebGLTexture | null;
	/** pixels have arrived from a worker and are waiting for upload */
	arrived: boolean;
	lastUsed: number;
	/** frame that last planned this tile (visible or look-ahead) */
	lastWanted: number;
}

interface PageRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const TILE = 512;
const BASE_MAX = 1024;
const ZOOM_SETTLE_MS = 180;
const UPLOAD_BUDGET_MS = 2.5;
const CLICK_SLOP = 4;
const AUTOSCROLL_EDGE = 48;
const LONG_PRESS_MS = 450;
const TOUCH_SLOP = 8;
/** handle knob radius and touch target, css px */
const HANDLE_R = 6;
const HANDLE_HIT = 32;

export class ViewerCore {
	private gl: Compositor;
	private pool: RasterPool;
	private opts: CoreOptions;

	// viewport (css px) and camera (doc points at viewport top-left)
	private vw = 0;
	private vh = 0;
	private dpr = 1;
	private cam = { x: 0, y: 0, zoom: 1 };
	private camReady = false;
	/** fit-width is sticky across resizes until the user zooms by hand */
	private fitMode = false;

	private pages: PageSize[] = [];
	private layout: PageRect[] = [];
	private docW = 0;
	private docH = 0;

	private tiles = new Map<string, Tile>();
	private tilesByPage = new Map<number, Set<Tile>>();
	private arrived: { tile: Tile; pixels: Uint8Array }[] = [];
	private targetScale = 1;
	private lastZoomChange = -1e9;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;

	private texts = new Map<number, PageText>();
	private textPending = new Set<number>();
	private links = new Map<number, Link[]>();
	private textWaiters = new Map<number, (() => void)[]>();

	// selection
	private selAnchor: [TextPoint, TextPoint] | null = null;
	private selRange: [TextPoint, TextPoint] | null = null;
	private selUnit: "char" | "word" | "line" = "char";
	private selRects: { page: number; rects: Rect[] }[] = [];
	private dragging = false;
	private pointer = { x: 0, y: 0 };
	private downAt: { x: number; y: number } | null = null;
	private cursor: Cursor = "default";
	private hovered: string | null = null;

	private highlights: Highlight[] = [];

	// touch
	private touches = new Map<number, { x: number; y: number }>();
	private pinch: { dist: number; zoom: number; cx: number; cy: number } | null = null;
	private velocity = { x: 0, y: 0 };
	private samples: { t: number; x: number; y: number }[] = [];
	private gestureZoom: number | null = null;
	private press: { x: number; y: number; t: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
	/** a finger is extending the selection (after a long-press or on a handle) */
	private touchSelect = false;
	/** finger -> hit-test point offset while dragging a handle */
	private grab = { dx: 0, dy: 0 };
	/** draw drag handles (the selection was made by touch) */
	private handles = false;

	// frame loop
	private dirty = false;
	private scheduled = false;
	private lastFrame = 0;
	private animating = false;
	private frameTimes: number[] = [];
	private cpuTimes: number[] = [];
	private tileMs: number[] = [];
	private lastStats = 0;
	private lastView = { zoom: 0, page: -1 };

	constructor(
		canvas: HTMLCanvasElement | OffscreenCanvas,
		ports: MessagePort[],
		private emit: (e: CoreEvent) => void,
		private raf: (cb: (t: number) => void) => void,
		options: Partial<CoreOptions> = {},
	) {
		this.opts = { ...defaultOptions, ...options };
		this.gl = new Compositor(canvas);
		this.pool = new RasterPool(ports);
		this.pool.onOpened = (pages) => this.opened(pages);
		this.pool.onError = (message) => this.emit({ type: "error", message });
	}

	// ---------------------------------------------------------------- setup

	private opened(pages: PageSize[]) {
		this.pages = pages;
		let y = this.opts.pageGap;
		this.docW = 0;
		this.layout = pages.map((p) => {
			const r = { x: -p.w / 2, y, w: p.w, h: p.h };
			y += p.h + this.opts.pageGap;
			this.docW = Math.max(this.docW, p.w);
			return r;
		});
		this.docH = y;
		this.emit({ type: "ready", pages, layout: this.layout.map((r) => ({ ...r })) });
		this.initCamera();
		this.requestFrame();
	}

	private initCamera() {
		if (this.camReady || this.vw === 0 || this.pages.length === 0) return;
		this.camReady = true;
		const fit = (this.vw - 32) / this.docW;
		this.fitMode = this.opts.initialZoom === "fit-width";
		const initial = this.opts.initialZoom;
		const z = initial === "fit-width" ? this.fitZoom() : initial;
		this.cam.zoom = this.clampZoom(z);
		this.cam.y = 0;
		this.clampCamera();
	}

	// ---------------------------------------------------------------- camera

	private fitZoom() {
		return Math.min((this.vw - 32) / this.docW, 2);
	}

	private clampZoom(z: number) {
		return Math.min(this.opts.maxZoom, Math.max(this.opts.minZoom, z));
	}

	private clampCamera() {
		const { zoom } = this.cam;
		const viewW = this.vw / zoom;
		const viewH = this.vh / zoom;
		const margin = 16 / zoom;
		if (this.docW + margin * 2 <= viewW) this.cam.x = -viewW / 2;
		else this.cam.x = Math.min(Math.max(this.cam.x, -this.docW / 2 - margin), this.docW / 2 + margin - viewW);
		if (this.docH <= viewH) this.cam.y = (this.docH - viewH) / 2;
		else this.cam.y = Math.min(Math.max(this.cam.y, 0), this.docH - viewH);
	}

	/** A zoom the user asked for: leaves fit-width mode. */
	private userZoom(zoom: number, sx: number, sy: number) {
		this.fitMode = false;
		this.zoomAt(zoom, sx, sy);
	}

	private zoomAt(zoom: number, sx: number, sy: number) {
		const z = this.clampZoom(zoom);
		if (z === this.cam.zoom) return;
		const px = this.cam.x + sx / this.cam.zoom;
		const py = this.cam.y + sy / this.cam.zoom;
		this.cam.zoom = z;
		this.cam.x = px - sx / z;
		this.cam.y = py - sy / z;
		this.clampCamera();
		this.zoomChanged();
	}

	private zoomChanged() {
		this.lastZoomChange = performance.now();
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => this.requestFrame(), ZOOM_SETTLE_MS + 10);
		this.requestFrame();
	}

	private panBy(dx: number, dy: number) {
		this.cam.x += dx / this.cam.zoom;
		this.cam.y += dy / this.cam.zoom;
		this.clampCamera();
		this.requestFrame();
	}

	// ---------------------------------------------------------------- input

	handle(msg: InputMsg) {
		switch (msg.type) {
			case "resize": {
				const changed = msg.w !== this.vw || msg.h !== this.vh || msg.dpr !== this.dpr;
				// Keep the doc point at the top-centre of the view fixed.
				const anchorX = this.cam.x + this.vw / 2 / this.cam.zoom;
				const anchorY = this.cam.y;
				this.vw = msg.w;
				this.vh = msg.h;
				this.dpr = msg.dpr;
				this.gl.resize(Math.round(msg.w * msg.dpr), Math.round(msg.h * msg.dpr));
				const wasReady = this.camReady;
				this.initCamera();
				if (changed && wasReady) {
					if (this.fitMode) {
						const z = this.clampZoom(this.fitZoom());
						if (z !== this.cam.zoom) {
							this.cam.zoom = z;
							this.zoomChanged();
						}
					}
					this.cam.x = anchorX - this.vw / 2 / this.cam.zoom;
					this.cam.y = anchorY;
					this.clampCamera();
				}
				// Resizing clears the drawing buffer: draw synchronously so the
				// new size never shows an empty frame.
				this.dirty = true;
				this.frame(performance.now());
				this.emit({ type: "resized", w: msg.w, h: msg.h });
				return;
			}
			case "wheel": {
				const unit = msg.mode === 1 ? 16 : msg.mode === 2 ? this.vh : 1;
				if (msg.ctrl) {
					if (this.gestureZoom !== null) return;
					const step = Math.max(-0.5, Math.min(0.5, -msg.dy * unit * 0.01));
					this.userZoom(this.cam.zoom * Math.exp(step), msg.x, msg.y);
				} else {
					this.velocity = { x: 0, y: 0 };
					this.panBy(msg.dx * unit, msg.dy * unit);
					if (this.dragging) this.updateDrag();
				}
				return;
			}
			case "gesture": {
				if (msg.phase === "start") this.gestureZoom = this.cam.zoom;
				else if (msg.phase === "change" && this.gestureZoom !== null) this.userZoom(this.gestureZoom * msg.scale, msg.x, msg.y);
				else this.gestureZoom = null;
				return;
			}
			case "pointer":
				if (msg.kind === "touch") this.touch(msg);
				else this.mouse(msg);
				return;
			case "key":
				this.key(msg);
				return;
			case "leave":
				this.setCursor("default");
				this.setHovered(null);
				return;
		}
	}

	private touch(msg: Extract<InputMsg, { type: "pointer" }>) {
		const prev = this.touches.get(msg.id);
		if (msg.phase === "down") {
			this.velocity = { x: 0, y: 0 };
			this.touches.set(msg.id, { x: msg.x, y: msg.y });
			this.samples = [];
			this.pinch = null;
			this.cancelPress();
			this.press = null;
			if (this.touches.size > 1) {
				// A second finger turns any selection drag into a pinch.
				this.endTouchSelect();
				return;
			}
			if (this.grabHandle(msg.x, msg.y)) return;
			this.press = { x: msg.x, y: msg.y, t: performance.now(), timer: setTimeout(() => this.longPress(), LONG_PRESS_MS) };
			return;
		}
		if (msg.phase === "up" || msg.phase === "cancel") {
			this.touches.delete(msg.id);
			this.pinch = null;
			const press = this.press;
			this.cancelPress();
			this.press = null;
			if (this.touchSelect) {
				this.endTouchSelect();
				return;
			}
			const tap = press && performance.now() - press.t < LONG_PRESS_MS;
			if (msg.phase === "up" && tap && this.touches.size === 0) {
				// Tap: dismiss a selection, otherwise click links and highlights.
				if (this.selRange) this.clearSelection();
				else this.click(msg.x, msg.y);
				return;
			}
			if (this.touches.size === 0) this.startMomentum();
			return;
		}
		if (!prev) return;
		if (this.touchSelect) {
			prev.x = msg.x;
			prev.y = msg.y;
			this.pointer = { x: msg.x + this.grab.dx, y: msg.y + this.grab.dy };
			this.updateDrag();
			return;
		}
		if (this.press && Math.hypot(msg.x - this.press.x, msg.y - this.press.y) > TOUCH_SLOP) {
			this.cancelPress();
			this.press = null;
		}
		if (this.touches.size === 1) {
			this.panBy(prev.x - msg.x, prev.y - msg.y);
			prev.x = msg.x;
			prev.y = msg.y;
			const t = performance.now();
			this.samples.push({ t, x: msg.x, y: msg.y });
			while (this.samples.length > 2 && t - this.samples[0]!.t > 80) this.samples.shift();
			return;
		}
		prev.x = msg.x;
		prev.y = msg.y;
		const [a, b] = [...this.touches.values()];
		if (!a || !b) return;
		const cx = (a.x + b.x) / 2;
		const cy = (a.y + b.y) / 2;
		const dist = Math.hypot(a.x - b.x, a.y - b.y);
		if (!this.pinch) {
			this.pinch = { dist, zoom: this.cam.zoom, cx, cy };
			return;
		}
		// Pan with the centroid, zoom about it: both at once, like a map.
		this.panBy(this.pinch.cx - cx, this.pinch.cy - cy);
		this.pinch.cx = cx;
		this.pinch.cy = cy;
		this.userZoom(this.pinch.zoom * (dist / this.pinch.dist), cx, cy);
	}

	private cancelPress() {
		if (this.press?.timer) clearTimeout(this.press.timer);
		if (this.press) this.press.timer = null;
	}

	/** Long-press on text selects the word; keep the finger down to extend it. */
	private longPress() {
		const press = this.press;
		if (!press || this.touches.size !== 1) return;
		press.timer = null;
		const at = this.toPage(press.x, press.y);
		const text = at && this.texts.get(at.page);
		if (!at || !text || !text.isOverText(at.x, at.y)) return;
		const hit = this.hitPoint(press.x, press.y);
		if (!hit) return;
		this.press = null;
		this.velocity = { x: 0, y: 0 };
		this.selUnit = "word";
		this.selAnchor = this.expand(hit);
		this.setFocus(hit);
		this.handles = true;
		this.touchSelect = true;
		this.dragging = true;
		this.grab = { dx: 0, dy: 0 };
		this.pointer = { x: press.x, y: press.y };
		this.emitSelection(false);
		this.requestFrame();
	}

	/** Touch down on a selection handle: drag that end, the other stays put. */
	private grabHandle(x: number, y: number) {
		if (!this.handles || !this.selRange) return false;
		const ends = this.handleEnds();
		if (!ends) return false;
		const [start, end] = ends;
		const ds = Math.hypot(x - start.x, y - (start.y - HANDLE_R));
		const de = Math.hypot(x - end.x, y - (end.y + end.h + HANDLE_R));
		if (Math.min(ds, de) > HANDLE_HIT) return false;
		const moving = de <= ds ? end : start;
		const fixed = de <= ds ? this.selRange[0] : this.selRange[1];
		this.selUnit = "char";
		this.selAnchor = [fixed, fixed];
		// Hit-test at the line the handle marks, not under the finger.
		this.grab = { dx: moving.x - x, dy: moving.y + moving.h / 2 - y };
		this.pointer = { x: x + this.grab.dx, y: y + this.grab.dy };
		this.touchSelect = true;
		this.dragging = true;
		this.emit({ type: "selection", selection: null, final: false });
		this.requestFrame();
		return true;
	}

	private endTouchSelect() {
		if (!this.touchSelect) return;
		this.touchSelect = false;
		this.dragging = false;
		this.emitSelection(true);
	}

	/** Screen (css px) caret boxes at the selection's start and end. */
	private handleEnds(): [Rect, Rect] | null {
		const first = this.selRects[0];
		const last = this.selRects[this.selRects.length - 1];
		const a = first?.rects[0];
		const z = last?.rects[last.rects.length - 1];
		if (!first || !last || !a || !z) return null;
		const s = this.screenRect(first.page, [a])!;
		const e = this.screenRect(last.page, [z])!;
		return [
			{ x: s.x, y: s.y, w: 0, h: s.h },
			{ x: e.x + e.w, y: e.y, w: 0, h: e.h },
		];
	}

	private startMomentum() {
		const s = this.samples;
		if (s.length < 2) return;
		const a = s[0]!;
		const z = s[s.length - 1]!;
		const dt = z.t - a.t;
		if (dt <= 0 || performance.now() - z.t > 60) return;
		this.velocity = { x: (a.x - z.x) / dt, y: (a.y - z.y) / dt };
		this.requestFrame();
	}

	private mouse(msg: Extract<InputMsg, { type: "pointer" }>) {
		this.pointer = { x: msg.x, y: msg.y };
		if (msg.phase === "down" && msg.buttons & 1) {
			this.downAt = { x: msg.x, y: msg.y };
			const hit = this.hitPoint(msg.x, msg.y);
			if (!hit) {
				this.clearSelection();
				return;
			}
			this.dragging = true;
			this.handles = false;
			this.emit({ type: "selection", selection: null, final: false });
			if (msg.shift && this.selRange) {
				this.selUnit = "char";
				this.selAnchor = [this.selRange[0], this.selRange[0]];
				this.setFocus(hit);
				return;
			}
			this.selUnit = msg.clicks >= 3 ? "line" : msg.clicks === 2 ? "word" : "char";
			this.selAnchor = this.expand(hit);
			if (this.selUnit === "char") this.setRange(null);
			else this.setFocus(hit);
			return;
		}
		if (msg.phase === "move") {
			if (this.dragging) this.updateDrag();
			else this.updateCursor(msg.x, msg.y);
			return;
		}
		if (msg.phase === "up" || msg.phase === "cancel") {
			const down = this.downAt;
			this.downAt = null;
			const click = msg.phase === "up" && down && Math.hypot(msg.x - down.x, msg.y - down.y) < CLICK_SLOP && msg.clicks <= 1;
			if (this.dragging) {
				this.dragging = false;
				this.emitSelection(true);
			}
			if (click && !this.selRange) this.click(msg.x, msg.y);
		}
	}

	/** Doc point -> page index and page-local point. */
	private toPage(sx: number, sy: number) {
		const dx = this.cam.x + sx / this.cam.zoom;
		const dy = this.cam.y + sy / this.cam.zoom;
		const page = this.pageAtDocY(dy);
		const r = this.layout[page];
		if (!r) return null;
		return { page, x: dx - r.x, y: dy - r.y, inside: dx >= r.x && dx <= r.x + r.w && dy >= r.y && dy <= r.y + r.h };
	}

	private highlightAt(page: number, x: number, y: number) {
		for (let i = this.highlights.length - 1; i >= 0; i--) {
			const h = this.highlights[i]!;
			if (h.page !== page || h.interactive === false) continue;
			for (const q of h.rects) if (x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h) return h;
		}
		return null;
	}

	private linkAt(page: number, x: number, y: number) {
		for (const l of this.links.get(page) ?? []) {
			if (x >= l.rect[0] && x <= l.rect[2] && y >= l.rect[1] && y <= l.rect[3]) return l;
		}
		return null;
	}

	/** Screen (css px) bounds of page-space rects. */
	private screenRect(page: number, rects: Rect[]): Rect | null {
		const r = this.layout[page];
		if (!r || rects.length === 0) return null;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const q of rects) {
			x0 = Math.min(x0, q.x);
			y0 = Math.min(y0, q.y);
			x1 = Math.max(x1, q.x + q.w);
			y1 = Math.max(y1, q.y + q.h);
		}
		const z = this.cam.zoom;
		return { x: (r.x + x0 - this.cam.x) * z, y: (r.y + y0 - this.cam.y) * z, w: (x1 - x0) * z, h: (y1 - y0) * z };
	}

	private click(sx: number, sy: number) {
		const at = this.toPage(sx, sy);
		if (!at || !at.inside) return;
		const h = this.highlightAt(at.page, at.x, at.y);
		if (h) {
			this.emit({ type: "highlight-click", id: h.id, screen: this.screenRect(h.page, h.rects)! });
			return;
		}
		const link = this.linkAt(at.page, at.x, at.y);
		if (link?.dest) {
			this.command({ type: "goto", page: link.dest.page, top: link.dest.top });
			return;
		}
		if (link?.url) {
			this.emit({ type: "link", url: link.url });
			return;
		}
		this.emit({ type: "click", page: at.page, x: at.x, y: at.y });
	}

	private key(msg: Extract<InputMsg, { type: "key" }>) {
		const line = 40;
		const page = this.vh * 0.9;
		const cx = this.vw / 2;
		const cy = this.vh / 2;
		if (msg.mod && (msg.key === "=" || msg.key === "+")) this.userZoom(this.cam.zoom * 1.25, cx, cy);
		else if (msg.mod && msg.key === "-") this.userZoom(this.cam.zoom / 1.25, cx, cy);
		else if (msg.mod && msg.key === "0") this.command({ type: "fit-width" });
		else if (msg.key === "ArrowDown") this.panBy(0, line);
		else if (msg.key === "ArrowUp") this.panBy(0, -line);
		else if (msg.key === "ArrowRight") this.panBy(line, 0);
		else if (msg.key === "ArrowLeft") this.panBy(-line, 0);
		else if (msg.key === "PageDown" || (msg.key === " " && !msg.shift)) this.panBy(0, page);
		else if (msg.key === "PageUp" || (msg.key === " " && msg.shift)) this.panBy(0, -page);
		else if (msg.key === "Home") this.panBy(0, -this.docH * this.cam.zoom);
		else if (msg.key === "End") this.panBy(0, this.docH * this.cam.zoom);
		else if (msg.key === "Escape") this.clearSelection();
	}

	command(cmd: Command) {
		switch (cmd.type) {
			case "zoom":
				this.userZoom(cmd.zoom, cmd.x ?? this.vw / 2, cmd.y ?? this.vh / 2);
				return;
			case "fit-width":
				this.zoomAt(this.fitZoom(), this.vw / 2, 0);
				this.fitMode = true;
				return;
			case "goto": {
				const r = this.layout[cmd.page];
				if (!r) return;
				this.cam.y = r.y + (cmd.top ?? 0) - this.opts.pageGap / this.cam.zoom;
				this.clampCamera();
				this.requestFrame();
				return;
			}
			case "highlights":
				this.highlights = cmd.items;
				this.requestFrame();
				return;
			case "reveal": {
				const r = this.layout[cmd.page];
				if (!r) return;
				const fits = Math.min(this.vw / (cmd.rect.w + 48), this.vh / (cmd.rect.h + 48));
				if (fits < this.cam.zoom) {
					this.cam.zoom = this.clampZoom(fits);
					this.zoomChanged();
				}
				this.cam.x = r.x + cmd.rect.x + cmd.rect.w / 2 - this.vw / 2 / this.cam.zoom;
				this.cam.y = r.y + cmd.rect.y + cmd.rect.h / 2 - this.vh / 2 / this.cam.zoom;
				this.clampCamera();
				this.requestFrame();
				return;
			}
			case "select":
				this.selectRange(cmd.page, cmd.from, cmd.to);
				return;
			case "request":
				this.answer(cmd.request).then(
					(result) => this.emit({ type: "response", id: cmd.id, result }),
					(err) => this.emit({ type: "response", id: cmd.id, result: { error: String(err) } }),
				);
				return;
			case "clear-selection":
				this.clearSelection();
				return;
			case "options":
				this.opts = { ...this.opts, ...cmd.options };
				this.requestFrame();
				return;
		}
	}

	// ---------------------------------------------------------------- queries

	private loadText(page: number): Promise<PageText> {
		const ready = this.texts.get(page);
		if (ready) return Promise.resolve(ready);
		return new Promise((resolve) => {
			const list = this.textWaiters.get(page) ?? [];
			list.push(() => resolve(this.texts.get(page)!));
			this.textWaiters.set(page, list);
			this.requestText(page, 500 + page);
		});
	}

	private outline: Promise<OutlineItem[]> | null = null;

	private async answer(req: Request): Promise<unknown> {
		switch (req.type) {
			case "page-text": {
				const text = await this.loadText(req.page);
				return text.text(0, text.length);
			}
			case "rects": {
				const text = await this.loadText(req.page);
				return text.rects(req.from, req.to);
			}
			case "thumbnail": {
				const size = this.pages[req.page];
				if (!size) throw new Error(`no page ${req.page}`);
				const scale = req.width / size.w;
				const w = Math.max(1, Math.round(size.w * scale));
				const h = Math.max(1, Math.round(size.h * scale));
				return new Promise((resolve) => {
					this.pool.request(`thumb:${req.page}:${w}`, 600 + req.page, { t: "tile", page: req.page, scale, x: 0, y: 0, w, h }, (res) =>
						resolve(res.t === "tile" ? { buf: res.buf, w: res.w, h: res.h } : null),
					);
					this.pool.pump();
				});
			}
			case "outline":
				this.outline ??= new Promise((resolve) => {
					this.pool.request("outline", 400, { t: "outline", page: -1 }, (res) => resolve(res.t === "outline" ? res.items : []));
					this.pool.pump();
				});
				return this.outline;
			case "search": {
				const query = req.query.trim().toLocaleLowerCase();
				if (!query) return [];
				const limit = req.limit ?? 500;
				const hits: SearchHit[] = [];
				const texts = await Promise.all(this.pages.map((_, i) => this.loadText(i)));
				for (let page = 0; page < texts.length && hits.length < limit; page++) {
					const text = texts[page]!;
					const { haystack, map } = text.searchable();
					for (let at = haystack.indexOf(query); at !== -1 && hits.length < limit; at = haystack.indexOf(query, at + 1)) {
						const from = map[at]!;
						const to = map[at + query.length - 1]! + 1;
						const s = Math.max(0, from - 40);
						hits.push({ page, index: from, length: to - from, snippet: text.text(s, Math.min(text.length, to + 40)), rects: text.rects(from, to) });
					}
				}
				return hits;
			}
		}
	}

	// ---------------------------------------------------------------- selection

	private pageAtDocY(y: number) {
		// binary search over the vertical stack
		let lo = 0;
		let hi = this.layout.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.layout[mid]!.y <= y) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}

	private hitPoint(sx: number, sy: number): TextPoint | null {
		if (this.layout.length === 0) return null;
		const dx = this.cam.x + sx / this.cam.zoom;
		const dy = this.cam.y + sy / this.cam.zoom;
		const page = this.pageAtDocY(dy);
		const r = this.layout[page]!;
		const text = this.texts.get(page);
		if (!text) {
			this.requestText(page, 0);
			return null;
		}
		if (dy > r.y + r.h) return { page, index: text.length };
		return { page, index: text.hitTest(dx - r.x, dy - r.y) };
	}

	private expand(p: TextPoint): [TextPoint, TextPoint] {
		const text = this.texts.get(p.page);
		if (!text || this.selUnit === "char") return [p, p];
		const [a, z] = this.selUnit === "word" ? text.wordAt(p.index) : text.lineAt(p.index);
		return [
			{ page: p.page, index: a },
			{ page: p.page, index: z },
		];
	}

	private setFocus(p: TextPoint) {
		if (!this.selAnchor) return;
		const [f0, f1] = this.expand(p);
		const [a0, a1] = this.selAnchor;
		const start = comparePoints(f0, a0) < 0 ? f0 : a0;
		const end = comparePoints(f1, a1) > 0 ? f1 : a1;
		this.setRange(comparePoints(start, end) === 0 ? null : [start, end]);
	}

	private updateDrag() {
		const hit = this.hitPoint(this.pointer.x, this.pointer.y);
		if (hit) this.setFocus(hit);
		this.requestFrame();
	}

	/** Programmatic selection of chars [from, to) on one page (e.g. from search). */
	selectRange(page: number, from: number, to: number) {
		this.selAnchor = [
			{ page, index: from },
			{ page, index: from },
		];
		this.setRange([
			{ page, index: from },
			{ page, index: to },
		]);
		this.emitSelection(true);
	}

	private setRange(range: [TextPoint, TextPoint] | null) {
		const same =
			range && this.selRange && comparePoints(range[0], this.selRange[0]) === 0 && comparePoints(range[1], this.selRange[1]) === 0;
		if (same || (!range && !this.selRange)) return;
		this.selRange = range;
		this.selRects = [];
		if (range) {
			const [s, e] = range;
			for (let page = s.page; page <= e.page; page++) {
				const text = this.texts.get(page);
				if (!text) continue;
				const from = page === s.page ? s.index : 0;
				const to = page === e.page ? e.index : text.length;
				this.selRects.push({ page, rects: text.rects(from, to) });
			}
		}
		this.requestFrame();
	}

	private clearSelection() {
		const had = this.selRange !== null;
		this.selAnchor = null;
		this.dragging = false;
		this.touchSelect = false;
		this.handles = false;
		this.setRange(null);
		if (had) this.emitSelection(true);
	}

	private selectionScreenAnchor(): Rect | null {
		const last = this.selRects[this.selRects.length - 1];
		if (!last || last.rects.length === 0) return null;
		return this.screenRect(last.page, [last.rects[last.rects.length - 1]!]);
	}

	private emitSelection(final: boolean) {
		if (!this.selRange) {
			this.emit({ type: "selection", selection: null, final });
			return;
		}
		this.emit({
			type: "selection",
			final,
			selection: {
				text: final ? this.selectedText() : "",
				pages: this.selRects.map((p) => ({ page: p.page, rects: p.rects.map((r) => ({ ...r })) })),
				anchor: this.selectionScreenAnchor(),
			},
		});
	}

	private selectedText() {
		if (!this.selRange) return "";
		const [s, e] = this.selRange;
		const parts: string[] = [];
		for (let page = s.page; page <= e.page; page++) {
			const text = this.texts.get(page);
			if (!text) continue;
			parts.push(text.text(page === s.page ? s.index : 0, page === e.page ? e.index : text.length));
		}
		return parts.join("\n");
	}

	private updateCursor(sx: number, sy: number) {
		const at = this.toPage(sx, sy);
		if (!at || !at.inside) {
			this.setHovered(null);
			this.setCursor("default");
			return;
		}
		const h = this.highlightAt(at.page, at.x, at.y);
		this.setHovered(h);
		if (h || this.linkAt(at.page, at.x, at.y)) {
			this.setCursor("pointer");
			return;
		}
		const text = this.texts.get(at.page);
		this.setCursor(text?.isOverText(at.x, at.y) ? "text" : "default");
	}

	private setHovered(h: Highlight | null) {
		const id = h?.id ?? null;
		if (id === this.hovered) return;
		this.hovered = id;
		this.emit({ type: "highlight-hover", id, screen: h ? this.screenRect(h.page, h.rects) : null });
	}

	private setCursor(c: Cursor) {
		if (c === this.cursor) return;
		this.cursor = c;
		this.emit({ type: "cursor", cursor: c });
	}

	private requestText(page: number, priority: number) {
		if (this.texts.has(page) || this.textPending.has(page)) return;
		this.textPending.add(page);
		this.pool.request(`text:${page}`, priority, { t: "text", page }, (res) => {
			this.textPending.delete(page);
			if (res.t !== "text") return;
			const r = res as TextResult;
			this.texts.set(page, new PageText(r.codes, r.boxes));
			this.links.set(page, r.links);
			for (const fn of this.textWaiters.get(page) ?? []) fn();
			this.textWaiters.delete(page);
			if (this.dragging) this.updateDrag();
			else this.updateCursor(this.pointer.x, this.pointer.y);
		});
		this.pool.pump();
	}

	// ---------------------------------------------------------------- tiles

	private baseScale(page: number) {
		const p = this.pages[page]!;
		return 2 ** Math.floor(Math.log2(BASE_MAX / Math.max(p.w, p.h)));
	}

	private tileKey(page: number, scale: number, x: number, y: number) {
		return `${page}:${scale}:${x}:${y}`;
	}

	private ensureTile(page: number, scale: number, x: number, y: number, w: number, h: number, priority: number, keep: Set<string>) {
		const key = this.tileKey(page, scale, x, y);
		const existing = this.tiles.get(key);
		if (existing) existing.lastWanted = this.frameId;
		if (existing && (existing.tex || existing.arrived)) return;
		keep.add(key);
		let tile = existing;
		if (!tile) {
			tile = { key, page, scale, x, y, w, h, tex: null, arrived: false, lastUsed: 0, lastWanted: this.frameId };
			this.tiles.set(key, tile);
			let set = this.tilesByPage.get(page);
			if (!set) this.tilesByPage.set(page, (set = new Set()));
			set.add(tile);
		}
		this.requestTile(tile, priority);
	}

	private requestTile(tile: Tile, priority: number) {
		const { key, page, scale, x, y, w, h } = tile;
		this.pool.request(key, priority, { t: "tile", page, scale, x, y, w, h }, (res) => {
			if (res.t !== "tile") return;
			const r = res as TileResult;
			this.tileMs.push(r.ms);
			if (this.tiles.get(key) !== tile || tile.tex || tile.arrived) return;
			tile.arrived = true;
			this.arrived.push({ tile, pixels: new Uint8Array(r.buf) });
			this.requestFrame();
		});
	}

	/** Visible doc-space rect, optionally grown by a fraction of the viewport. */
	private viewRect(grow = 0) {
		const w = this.vw / this.cam.zoom;
		const h = this.vh / this.cam.zoom;
		return { x0: this.cam.x - w * grow, y0: this.cam.y - h * grow, x1: this.cam.x + w * (1 + grow), y1: this.cam.y + h * (1 + grow) };
	}

	private pagesIn(v: { y0: number; y1: number }) {
		const out: number[] = [];
		if (this.layout.length === 0) return out;
		for (let p = this.pageAtDocY(v.y0); p < this.layout.length; p++) {
			const r = this.layout[p]!;
			if (r.y > v.y1) break;
			if (r.y + r.h >= v.y0) out.push(p);
		}
		return out;
	}

	private plan(now: number) {
		const S = this.cam.zoom * this.dpr;
		const zooming = now - this.lastZoomChange < ZOOM_SETTLE_MS;
		// While the zoom is moving, use a power-of-two pyramid so tiles are
		// reused across frames; once it settles, render at the exact scale.
		const raw = zooming ? 2 ** Math.ceil(Math.log2(S) - 0.05) : S;
		this.targetScale = Math.round(raw * 4096) / 4096;
		const keep = new Set<string>();
		// Near the texture budget, keep what is cached ahead but stop fetching more.
		const roomAhead = this.gl.textureBytes < this.opts.textureBudgetMB * 1024 * 1024 * 0.8;
		const view = this.viewRect();
		const ahead = this.viewRect(0.75);
		const visible = this.pagesIn(view);
		const near = this.pagesIn(ahead);
		const cx = (view.x0 + view.x1) / 2;
		const cy = (view.y0 + view.y1) / 2;

		// 1. a whole-page base bitmap for everything near the viewport: never blank
		const first = Math.max(0, (near[0] ?? 0) - 3);
		const last = Math.min(this.layout.length - 1, (near[near.length - 1] ?? 0) + 3);
		for (let p = first; p <= last; p++) {
			const s = this.baseScale(p);
			const size = this.pages[p]!;
			const dist = Math.abs(this.layout[p]!.y + this.layout[p]!.h / 2 - cy);
			this.ensureTile(p, s, 0, 0, Math.round(size.w * s), Math.round(size.h * s), dist / 1e6, keep);
		}

		// 2. sharp tiles: visible first (by distance from centre), then look-ahead
		for (const [pages, region, base] of [
			[visible, view, 10],
			[near, ahead, 30],
		] as const) {
			for (const p of pages) {
				if (base === 10) this.requestText(p, 20);
				const s = this.targetScale;
				if (s <= this.baseScale(p)) continue;
				const r = this.layout[p]!;
				const pw = Math.round(r.w * s);
				const ph = Math.round(r.h * s);
				const lx0 = Math.max(0, (region.x0 - r.x) * s);
				const ly0 = Math.max(0, (region.y0 - r.y) * s);
				const lx1 = Math.min(pw, (region.x1 - r.x) * s);
				const ly1 = Math.min(ph, (region.y1 - r.y) * s);
				if (lx1 <= lx0 || ly1 <= ly0) continue;
				for (let ty = Math.floor(ly0 / TILE); ty * TILE < ly1; ty++) {
					for (let tx = Math.floor(lx0 / TILE); tx * TILE < lx1; tx++) {
						const x = tx * TILE;
						const y = ty * TILE;
						const dx = r.x + (x + TILE / 2) / s - cx;
						const dy = r.y + (y + TILE / 2) / s - cy;
						if (base === 30 && !roomAhead && !this.tiles.has(this.tileKey(p, s, x, y))) continue;
						const prio = base + Math.hypot(dx, dy) * this.cam.zoom * 1e-4;
						this.ensureTile(p, s, x, y, Math.min(TILE, pw - x), Math.min(TILE, ph - y), prio, keep);
					}
				}
			}
		}
		this.pool.retain(keep);
		this.pool.pump();
		// Placeholder tiles that will never be rendered are forgotten.
		for (const tile of this.tiles.values()) {
			if (!tile.tex && !tile.arrived && !keep.has(tile.key) && !this.pool.has(tile.key)) this.dropTile(tile);
		}
		return visible;
	}

	private dropTile(tile: Tile) {
		this.tiles.delete(tile.key);
		this.tilesByPage.get(tile.page)?.delete(tile);
		if (tile.tex) this.gl.free(tile.tex, tile.w, tile.h);
	}

	private uploadArrived() {
		const t0 = performance.now();
		while (this.arrived.length > 0 && performance.now() - t0 < UPLOAD_BUDGET_MS) {
			const { tile, pixels } = this.arrived.shift()!;
			tile.arrived = false;
			if (this.tiles.get(tile.key) !== tile || tile.tex) continue;
			tile.tex = this.gl.upload(pixels, tile.w, tile.h);
		}
	}

	private evict(frameId: number) {
		const budget = this.opts.textureBudgetMB * 1024 * 1024;
		if (this.gl.textureBytes <= budget) return;
		// Tiles this frame drew or planned (look-ahead) stay: evicting a planned
		// tile only makes the next plan request it again.
		const candidates = [...this.tiles.values()]
			.filter((t) => t.tex && t.lastUsed !== frameId && t.lastWanted !== frameId)
			.sort((a, b) => a.lastUsed - b.lastUsed);
		for (const t of candidates) {
			if (this.gl.textureBytes <= budget * 0.85) break;
			this.dropTile(t);
		}
		// Still over: give up look-ahead tiles too (never what is on screen).
		if (this.gl.textureBytes <= budget) return;
		const ahead = [...this.tiles.values()].filter((t) => t.tex && t.lastUsed !== frameId).sort((a, b) => a.lastUsed - b.lastUsed);
		for (const t of ahead) {
			if (this.gl.textureBytes <= budget) break;
			this.dropTile(t);
		}
	}

	// ---------------------------------------------------------------- frame

	requestFrame() {
		this.dirty = true;
		if (this.scheduled) return;
		this.scheduled = true;
		this.raf((t) => {
			this.scheduled = false;
			this.frame(t);
		});
	}

	private frameId = 0;

	private frame(now: number) {
		if (!this.dirty || !this.camReady) return;
		const cpu0 = performance.now();
		const dt = this.lastFrame ? Math.min(64, now - this.lastFrame) : 16;
		if (this.lastFrame && now - this.lastFrame < 50) this.frameTimes.push(now - this.lastFrame);
		this.lastFrame = now;
		this.dirty = false;
		this.frameId++;

		let moving = false;
		// touch momentum
		if (Math.abs(this.velocity.x) + Math.abs(this.velocity.y) > 0.02) {
			this.panBy(this.velocity.x * dt, this.velocity.y * dt);
			const decay = Math.exp(-dt / 325);
			this.velocity.x *= decay;
			this.velocity.y *= decay;
			moving = true;
		}
		// selection autoscroll
		if (this.dragging) {
			const { x, y } = this.pointer;
			const edge = (v: number, max: number) =>
				v < AUTOSCROLL_EDGE ? v - AUTOSCROLL_EDGE : v > max - AUTOSCROLL_EDGE ? v - (max - AUTOSCROLL_EDGE) : 0;
			const ex = edge(x, this.vw);
			const ey = edge(y, this.vh);
			if (ex || ey) {
				this.panBy(ex * dt * 0.02, ey * dt * 0.02);
				this.updateDrag();
				moving = true;
			}
		}

		const visible = this.plan(now);
		this.uploadArrived();
		this.draw(visible);
		this.evict(this.frameId);

		this.cpuTimes.push(performance.now() - cpu0);
		this.reportView(visible);
		this.reportStats(now);

		this.animating = moving || this.arrived.length > 0 || this.dirty;
		if (this.animating) this.requestFrame();
	}

	private draw(visible: number[]) {
		const gl = this.gl;
		const S = this.cam.zoom * this.dpr;
		const target = this.targetScale;
		const { background, selectionColor, selectionColorDark, highlightColor, gamma, dark, paper, ink } = this.opts;
		gl.setTone(dark ? { paper, ink } : null);
		// Marks sit behind the text in both modes. Light: multiply, so black ink
		// stays black. Dark: lighten (per-channel max), so the dark paper takes
		// the colour while light ink stays on top, untinted.
		const markBlend = dark ? "lighten" : "multiply";
		// Light: the colour composited over white, so alpha still reads as strength.
		// Dark: a deep version of the colour over the paper, so light ink keeps its contrast.
		const mark = (c: Color): Color =>
			dark
				? [paper[0] + (c[0] * 0.55 - paper[0]) * c[3], paper[1] + (c[1] * 0.55 - paper[1]) * c[3], paper[2] + (c[2] * 0.55 - paper[2]) * c[3], 1]
				: [1 - c[3] * (1 - c[0]), 1 - c[3] * (1 - c[1]), 1 - c[3] * (1 - c[2]), 1];
		const px = this.dpr;
		gl.resetState();
		gl.begin(background);
		const view = this.viewRect();
		for (const p of visible) {
			const r = this.layout[p]!;
			const sx = (r.x - this.cam.x) * S;
			const sy = (r.y - this.cam.y) * S;
			gl.drawRect(sx - 1, sy - 1, r.w * S + 2, r.h * S + 2, [0, 0, 0, 0.12], "alpha");
			gl.drawRect(sx, sy, r.w * S, r.h * S, dark ? [paper[0], paper[1], paper[2], 1] : [1, 1, 1, 1]);

			// Visible part of the page in page points, to skip off-screen tiles.
			const vx0 = view.x0 - r.x;
			const vy0 = view.y0 - r.y;
			const vx1 = view.x1 - r.x;
			const vy1 = view.y1 - r.y;
			const ready: Tile[] = [];
			for (const t of this.tilesByPage.get(p) ?? []) {
				if (!t.tex) continue;
				if (t.x / t.scale > vx1 || (t.x + t.w) / t.scale < vx0 || t.y / t.scale > vy1 || (t.y + t.h) / t.scale < vy0) continue;
				ready.push(t);
			}
			// Coarse first, the target scale last so it ends up on top.
			ready.sort((a, b) => (a.scale === target ? 1 : 0) - (b.scale === target ? 1 : 0) || a.scale - b.scale);
			// If the target scale fully covers the view, skip the fallbacks.
			const start = this.coveredByTarget(p, ready, target) ? ready.findIndex((t) => t.scale === target) : 0;
			for (let i = Math.max(0, start); i < ready.length; i++) {
				const t = ready[i]!;
				const k = S / t.scale;
				let x = sx + t.x * k;
				let y = sy + t.y * k;
				if (Math.abs(k - 1) < 1e-3) {
					// Exact scale: pin to whole device pixels so glyphs stay crisp.
					x = Math.round(x);
					y = Math.round(y);
				}
				gl.drawTexture(t.tex!, x, y, t.w * k, t.h * k, gamma);
				t.lastUsed = this.frameId;
			}

			for (const h of this.highlights) {
				if (h.page !== p) continue;
				const color = mark(h.color ?? highlightColor);
				const style = h.style ?? "fill";
				for (const q of h.rects) {
					const x = sx + q.x * S;
					const y = sy + q.y * S;
					const w = q.w * S;
					const hh = q.h * S;
					if (style === "fill") gl.drawRect(x, y, w, hh, color, markBlend);
					else if (style === "underline") gl.drawRect(x, y + hh - 2 * px, w, 2 * px, h.color ?? highlightColor, "alpha");
					else {
						const c = h.color ?? highlightColor;
						const b = 2 * px;
						gl.drawRect(x - b, y - b, w + 2 * b, b, c, "alpha");
						gl.drawRect(x - b, y + hh, w + 2 * b, b, c, "alpha");
						gl.drawRect(x - b, y, b, hh, c, "alpha");
						gl.drawRect(x + w, y, b, hh, c, "alpha");
					}
				}
			}
			for (const sel of this.selRects) {
				if (sel.page !== p) continue;
				const c = dark ? selectionColorDark : mark(selectionColor);
				for (const q of sel.rects) gl.drawRect(sx + q.x * S, sy + q.y * S, q.w * S, q.h * S, c, markBlend);
			}
		}
		const ends = this.handles ? this.handleEnds() : null;
		if (ends) {
			const d = this.dpr;
			const c: Color = [0.16, 0.45, 0.95, 1];
			// Like iOS: the start knob sits above the line, the end knob below.
			ends.forEach((e, i) => {
				const knob = i === 0 ? e.y - HANDLE_R : e.y + e.h + HANDLE_R;
				gl.drawRect((e.x - 1) * d, Math.min(e.y, knob) * d, 2 * d, (e.h + HANDLE_R) * d, c, "alpha");
				gl.drawCircle(e.x * d, knob * d, HANDLE_R * d, c);
			});
		}
	}

	private coveredByTarget(page: number, ready: Tile[], target: number) {
		const r = this.layout[page]!;
		const view = this.viewRect();
		const pw = Math.round(r.w * target);
		const ph = Math.round(r.h * target);
		const lx0 = Math.max(0, (view.x0 - r.x) * target);
		const ly0 = Math.max(0, (view.y0 - r.y) * target);
		const lx1 = Math.min(pw, (view.x1 - r.x) * target);
		const ly1 = Math.min(ph, (view.y1 - r.y) * target);
		if (lx1 <= lx0 || ly1 <= ly0) return true;
		let need = 0;
		for (let ty = Math.floor(ly0 / TILE); ty * TILE < ly1; ty++) for (let tx = Math.floor(lx0 / TILE); tx * TILE < lx1; tx++) need++;
		let have = 0;
		for (const t of ready) if (t.scale === target) have++;
		return have >= need;
	}

	private lastCam: Camera = { x: 0, y: 0, zoom: 0 };
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	/** Emits `moving: false` once the camera has rested; hosts re-show tooltips then. */
	private cameraIdle() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.emit({ type: "camera", camera: { ...this.cam }, moving: false });
			if (this.selRange && !this.dragging) this.emitSelection(true);
			if (this.hovered) this.updateCursor(this.pointer.x, this.pointer.y);
		}, 140);
	}

	private reportView(visible: number[]) {
		const view = this.viewRect();
		const mid = (view.y0 + view.y1) / 2;
		const page = visible.length ? this.pageAtDocY(mid) : 0;
		const cam = this.cam;
		if (cam.x !== this.lastCam.x || cam.y !== this.lastCam.y || cam.zoom !== this.lastCam.zoom) {
			this.lastCam = { ...cam };
			this.emit({ type: "camera", camera: { ...cam }, moving: true });
			this.cameraIdle();
		}
		if (page === this.lastView.page && this.cam.zoom === this.lastView.zoom) return;
		this.lastView = { page, zoom: this.cam.zoom };
		this.emit({ type: "view", zoom: this.cam.zoom, page, pageCount: this.pages.length });
	}

	private reportStats(now: number) {
		if (now - this.lastStats < 500) return;
		this.lastStats = now;
		const ft = [...this.frameTimes].sort((a, b) => a - b);
		const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
		const total = this.frameTimes.reduce((a, b) => a + b, 0);
		this.emit({
			type: "stats",
			stats: {
				fps: total > 0 ? (this.frameTimes.length * 1000) / total : 0,
				p95FrameMs: ft[Math.floor(ft.length * 0.95)] ?? 0,
				worstFrameMs: ft[ft.length - 1] ?? 0,
				avgCpuMs: avg(this.cpuTimes),
				tiles: this.tiles.size,
				textureMB: this.gl.textureBytes / 1048576,
				pendingJobs: this.pool.pending,
				avgTileMs: avg(this.tileMs),
				targetScale: this.targetScale,
				workers: this.pool.workers,
			},
		});
		this.frameTimes = [];
		this.cpuTimes = [];
		this.tileMs = [];
	}
}
