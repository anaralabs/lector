// The viewer core. It owns the camera, page layout, tile pyramid, text
// selection and the WebGL frame loop. It never touches the DOM, so the same
// code runs on the main thread or inside a worker with an OffscreenCanvas.

import { Compositor } from "./gl";
import type { ErrorCode, ErrorPhase, Link, OutlineItem, PageSize } from "./protocol";
import { RasterPool, type TextResult, type TileResult } from "./raster-pool";
import { boundedDistance, foldQuery, insertRanked, matchPage, type RawMatch, type SearchOptions, splitLimit } from "./search";
import { PageText, type Rect, type SelectionTextOptions, type TextPoint, comparePoints } from "./text";

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
	/** camera flights (animated reveal/goto) jump instantly; set from prefers-reduced-motion */
	reducedMotion: boolean;
	/** how selected text is copied (lector's `copyOptions`); false leaves Cmd/Ctrl+C to the browser */
	copyOptions: false | SelectionTextOptions;
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
	reducedMotion: false,
	copyOptions: {},
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

/**
 * ripple: a copy of the highlight grows outward and fades (repeat-click / landing cue).
 * flash: the highlight itself blinks in and out (whole-page citations); it stays
 * hidden after the flash until it is removed.
 */
export type PulseKind = "ripple" | "flash";

/**
 * Where a revealed rect lands: its top at this fraction of the viewport height
 * ("auto" = 0.3, like a reading position), centred, or at the top edge.
 */
export type RevealAlign = "auto" | "center" | "start" | number;

export interface SearchHit {
	/** where the match starts: page, char index (as `rects`/`select` take) and length on that page */
	page: number;
	index: number;
	length: number;
	/** the match with some surrounding context */
	snippet: string;
	/** rects on `page` */
	rects: Rect[];
	/** 1 for exact matches, else 1 - edits/query length */
	score: number;
	/** one part per page the match covers (two when it crosses a page break); the first is `page`/`index`/`length`/`rects` */
	parts: { page: number; index: number; length: number; rects: Rect[] }[];
}

/** Like @anaralabs/lector's `useSearch` results. */
export interface SearchResults {
	exactMatches: SearchHit[];
	/** best-first */
	fuzzyMatches: SearchHit[];
	hasMoreResults: boolean;
	/** pages searched so far (equals `pageCount` in the final result unless cancelled) */
	pagesSearched: number;
	pageCount: number;
	done: boolean;
}

export type Request =
	/** exact matches only, in document order (folding as SearchOptions; default limit 500) */
	| { type: "search"; query: string; limit?: number; pages?: number[]; matchDiacritics?: boolean; ignoreHyphenation?: boolean }
	/** exact + fuzzy matches; `progress` streams `search-progress` events with partial results */
	| ({ type: "search-results"; query: string; progress?: boolean } & SearchOptions)
	| { type: "outline" }
	| { type: "page-text"; page: number }
	/** page text plus, per UTF-16 unit, the char index that `rects` takes */
	| { type: "page-text-map"; page: number }
	| { type: "rects"; page: number; from: number; to: number }
	/** lines of text with their boxes, for the hidden DOM text layer */
	| { type: "text-layer"; page: number }
	| { type: "thumbnail"; page: number; width: number };

export type Command =
	| { type: "zoom"; zoom: number; x?: number; y?: number }
	| { type: "fit-width" }
	/** `flight`: id echoed in the `flight` event when the camera lands (or is interrupted) */
	| { type: "goto"; page: number; top?: number; animate?: boolean; flight?: number }
	/**
	 * Bring `rect` (page points) into view: its top lands at `align` (default 0.3 of
	 * the viewport height), x only moves if it does not fit, and the zoom only drops
	 * if the rect is taller than 80% of the viewport. `ifNeeded`: no move when the
	 * rect is already fully visible.
	 */
	| { type: "reveal"; page: number; rect: Rect; animate?: boolean; align?: RevealAlign; ifNeeded?: boolean; flight?: number }
	/** animate highlights by id (see PulseKind) */
	| { type: "pulse"; ids: string[]; kind?: PulseKind; duration?: number }
	| { type: "request"; id: number; request: Request }
	/** stop a running request (searches); it answers with `{ error: "cancelled" }` */
	| { type: "cancel"; id: number }
	| { type: "select"; page: number; from: number; to: number }
	/** select across pages (e.g. restoring a saved `SelectionInfo.range`); null clears */
	| { type: "set-selection"; range: { start: TextPoint; end: TextPoint } | null }
	| { type: "highlights"; items: Highlight[] }
	| { type: "clear-selection" }
	/** pan by css px (e.g. the browser scrolled the hidden text layer to a find match) */
	| { type: "scroll-by"; dx: number; dy: number }
	/** select all text: the current page, or the whole document when that page is already selected (Cmd/Ctrl+A) */
	| { type: "select-all"; scope?: "page" | "document" | "auto" }
	/** retry opening an encrypted document with this password */
	| { type: "unlock"; password: string }
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
	/** selected text, as copied (see `copyOptions`) */
	text: string;
	/** start (inclusive) and end (exclusive) caret positions: persist these to restore the selection with `setSelection` */
	range: { start: TextPoint; end: TextPoint };
	/** per-page rects in page points (top-left origin) */
	pages: { page: number; rects: Rect[] }[];
	/** bounding box of the selection's last line, in viewport css px (for tooltips) */
	anchor: Rect | null;
}

export type Cursor = "default" | "text" | "pointer";

export type CoreEvent =
	| { type: "ready"; pages: PageSize[]; layout: Rect[] }
	| { type: "view"; zoom: number; page: number; pageCount: number; fitWidth: boolean }
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
	/** partial results of a `search-results` request with `progress` */
	| { type: "search-progress"; id: number; results: SearchResults }
	/** Cmd/Ctrl+F while the viewer has focus, with `interceptFind` on: open the host's search */
	| { type: "find" }
	/**
	 * An animated (or instant) reveal/goto finished. `landed: false` when input or
	 * another jump interrupted it. `coverage`: share of the landing view already
	 * covered by sharp tiles; `waitMs`: how long the flight waited for bitmaps.
	 */
	| { type: "flight"; id: number; landed: boolean; coverage: number; waitMs: number; durationMs: number }
	| { type: "stats"; stats: Stats }
	/** `code`/`phase` say what failed and when (see ErrorCode, ErrorPhase) */
	| { type: "error"; message: string; code: ErrorCode; phase: ErrorPhase };

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
	/** the worker failed to render it: not requested again */
	failed?: boolean;
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
/** a flight waits this long at most for destination bitmaps before it starts */
const FLIGHT_WAIT_MS = 80;
/** jumps longer than this many viewports cut to one viewport short, then ease in */
const FLIGHT_TELEPORT = 3;
/** css px kept between a revealed rect and the viewport edge */
const REVEAL_MARGIN = 24;
const FADE_IN_MS = 150;
const RIPPLE_MS = 1000;
const FLASH_MS = 1200;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** pdf-fullpage-pulse keyframes (opacity relative to the peak), eased between keys */
const FLASH_KEYS: [number, number][] = [
	[0, 0],
	[0.3, 1],
	[0.5, 0.34],
	[0.7, 0.86],
	[1, 0],
];
function flashCurve(t: number) {
	for (let i = 1; i < FLASH_KEYS.length; i++) {
		const [t1, v1] = FLASH_KEYS[i]!;
		if (t > t1) continue;
		const [t0, v0] = FLASH_KEYS[i - 1]!;
		const k = (t - t0) / (t1 - t0);
		return v0 + (v1 - v0) * k * k * (3 - 2 * k);
	}
	return 0;
}

interface Flight {
	/** host id echoed in the `flight` event; 0 for internal jumps (links) */
	id: number;
	from: Camera;
	to: Camera;
	/** fit-width mode once landed */
	fit: boolean;
	requested: number;
	/** frame time the motion began; -1 while waiting for destination bitmaps */
	start: number;
	dur: number;
	/** pages on the path and at the destination: their base bitmaps must be ready */
	pages: number[];
	/** recomputes the destination (after a resize) */
	retarget: () => { cam: Camera; fit: boolean } | null;
}

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
	/** raster image boxes per page (l, t, r, b in points), kept in original colours in dark mode */
	private images = new Map<number, Float32Array>();
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
	/** when each highlight id first appeared (for the fade-in) */
	private born = new Map<string, number>();
	private pulses = new Map<string, { kind: PulseKind; start: number; dur: number }>();

	private flight: Flight | null = null;
	/** tiles a flight needs at its destination: eviction never drops these */
	private pinned = new Set<string>();

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
	private lastView = { zoom: 0, page: -1, fit: false };

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
		this.pool.onError = (message, code, phase) => this.emit({ type: "error", message, code, phase });
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
		this.clampCam(this.cam);
	}

	private clampCam(cam: Camera) {
		const { zoom } = cam;
		const viewW = this.vw / zoom;
		const viewH = this.vh / zoom;
		const margin = 16 / zoom;
		if (this.docW + margin * 2 <= viewW) cam.x = -viewW / 2;
		else cam.x = Math.min(Math.max(cam.x, -this.docW / 2 - margin), this.docW / 2 + margin - viewW);
		if (this.docH <= viewH) cam.y = (this.docH - viewH) / 2;
		else cam.y = Math.min(Math.max(cam.y, 0), this.docH - viewH);
		return cam;
	}

	// ---------------------------------------------------------------- flights

	/** Camera that shows `rect` on `page` (see the `reveal` command). */
	private revealTarget(page: number, rect: Rect, align: RevealAlign = "auto", ifNeeded = false): { cam: Camera; fit: boolean } | null {
		const r = this.layout[page];
		if (!r || this.vw === 0) return null;
		const m = REVEAL_MARGIN;
		const cur = this.cam;
		const dx0 = r.x + rect.x;
		const dy0 = r.y + rect.y;
		if (ifNeeded) {
			const v = this.viewRect();
			const mz = m / cur.zoom;
			if (dx0 >= v.x0 && dx0 + rect.w <= v.x1 && dy0 >= v.y0 + mz && dy0 + rect.h <= v.y1 - mz) return { cam: { ...cur }, fit: this.fitMode };
		}
		// Zoom out only when the rect cannot be read whole.
		let zoom = cur.zoom;
		if (rect.h * zoom > this.vh * 0.8) zoom = (this.vh * 0.8) / rect.h;
		if (rect.w * zoom > this.vw - 2 * m) zoom = Math.min(zoom, (this.vw - 2 * m) / rect.w);
		zoom = this.clampZoom(zoom);
		const fit = zoom === cur.zoom ? this.fitMode : false;
		const viewW = this.vw / zoom;
		// Keep the horizontal centre when zooming; recentre only if the rect is cut off.
		let x = zoom === cur.zoom ? cur.x : cur.x + this.vw / 2 / cur.zoom - viewW / 2;
		const mx = m / zoom;
		if (dx0 < x + mx || dx0 + rect.w > x + viewW - mx) x = dx0 + rect.w / 2 - viewW / 2;
		const hpx = rect.h * zoom;
		let top = align === "center" ? (this.vh - hpx) / 2 : align === "start" ? m : this.vh * (typeof align === "number" ? align : 0.3);
		top = Math.max(m, Math.min(top, this.vh - hpx - m));
		return { cam: this.clampCam({ x, y: dy0 - top / zoom, zoom }), fit };
	}

	private gotoTarget(page: number, top = 0): { cam: Camera; fit: boolean } | null {
		const r = this.layout[page];
		if (!r) return null;
		return { cam: this.clampCam({ x: this.cam.x, y: r.y + top - this.opts.pageGap / this.cam.zoom, zoom: this.cam.zoom }), fit: this.fitMode };
	}

	/** Move the camera to the target, animated unless asked otherwise or reduced motion is on. */
	private fly(id: number, animate: boolean, retarget: Flight["retarget"]) {
		this.cancelFlight();
		this.velocity = { x: 0, y: 0 };
		const target = this.camReady ? retarget() : null;
		if (!target) {
			if (id) this.emit({ type: "flight", id, landed: false, coverage: 0, waitMs: 0, durationMs: 0 });
			return;
		}
		const to = target.cam;
		const from = { ...this.cam };
		const centre = (c: Camera) => ({ x: c.x + this.vw / 2 / c.zoom, y: c.y + this.vh / 2 / c.zoom });
		const a = centre(from);
		const b = centre(to);
		const zoomSteps = Math.abs(Math.log2(to.zoom / from.zoom));
		let dist = Math.hypot(b.x - a.x, b.y - a.y) * to.zoom;
		if (!animate || this.opts.reducedMotion || (dist < 1 && zoomSteps < 0.01)) {
			const zoomed = to.zoom !== this.cam.zoom;
			this.cam = { ...to };
			this.fitMode = target.fit;
			if (zoomed) this.zoomChanged();
			this.requestFrame();
			if (id) this.emit({ type: "flight", id, landed: true, coverage: this.coverage(this.pagesIn(this.viewRect())), waitMs: 0, durationMs: 0 });
			return;
		}
		// Long jumps cut to one viewport short of the target and ease in from
		// there: the pages in between are never drawn (or rasterised).
		if (dist > FLIGHT_TELEPORT * this.vh) {
			const k = 1 - this.vh / dist;
			const cx = a.x + (b.x - a.x) * k;
			const cy = a.y + (b.y - a.y) * k;
			from.x = cx - this.vw / 2 / from.zoom;
			from.y = cy - this.vh / 2 / from.zoom;
			dist = this.vh;
		}
		const travel = dist / this.vh + zoomSteps * 0.5;
		const dur = Math.min(600, Math.max(220, 180 + 90 * Math.log2(1 + travel)));
		const fv = this.viewRect(0, from);
		const tv = this.viewRect(0, to);
		const pages = this.pagesIn({ y0: Math.min(fv.y0, tv.y0), y1: Math.max(fv.y1, tv.y1) });
		this.flight = { id, from, to, fit: target.fit, requested: performance.now(), start: -1, dur, pages, retarget };
		this.requestFrame();
	}

	/** Stop a flight where it is (user input or another jump). */
	private cancelFlight() {
		const f = this.flight;
		if (!f) return;
		this.flight = null;
		this.pinned.clear();
		if (this.cam.zoom !== f.from.zoom) {
			this.fitMode = false;
			this.zoomChanged();
		}
		if (f.id) this.emit({ type: "flight", id: f.id, landed: false, coverage: 0, waitMs: 0, durationMs: 0 });
		this.requestFrame();
	}

	/** Advance the flight for this frame; true while it is still going. */
	private stepFlight(now: number) {
		const f = this.flight;
		if (!f) return false;
		if (f.start < 0) {
			const ready = f.pages.every((p) => this.tiles.get(this.tileKey(p, this.baseScale(p), 0, 0))?.tex);
			if (!ready && performance.now() - f.requested < FLIGHT_WAIT_MS) return true;
			f.start = now;
		}
		const t = Math.min(1, (now - f.start) / f.dur);
		if (t >= 1) {
			this.cam = { ...f.to };
			this.fitMode = f.fit;
			this.flight = null;
			this.pinned.clear();
			if (f.id) {
				const waitMs = Math.max(0, f.start - f.requested);
				this.emit({ type: "flight", id: f.id, landed: true, coverage: this.coverage(this.pagesIn(this.viewRect())), waitMs, durationMs: f.dur });
			}
			return false;
		}
		const e = easeOutCubic(t);
		// Zoom moves in log space; the viewport centre moves in a straight line.
		const z = Math.exp(Math.log(f.from.zoom) + (Math.log(f.to.zoom) - Math.log(f.from.zoom)) * e);
		const ax = f.from.x + this.vw / 2 / f.from.zoom;
		const ay = f.from.y + this.vh / 2 / f.from.zoom;
		const bx = f.to.x + this.vw / 2 / f.to.zoom;
		const by = f.to.y + this.vh / 2 / f.to.zoom;
		this.cam = this.clampCam({ x: ax + (bx - ax) * e - this.vw / 2 / z, y: ay + (by - ay) * e - this.vh / 2 / z, zoom: z });
		return true;
	}

	/** Share of the visible area already drawn by tiles at the target scale (1 = sharp). */
	private coverage(pages: number[]) {
		const view = this.viewRect();
		const target = this.targetScale;
		let need = 0;
		let have = 0;
		for (const p of pages) {
			const r = this.layout[p]!;
			if (target <= this.baseScale(p)) {
				need++;
				if (this.tiles.get(this.tileKey(p, this.baseScale(p), 0, 0))?.tex) have++;
				continue;
			}
			const pw = Math.round(r.w * target);
			const ph = Math.round(r.h * target);
			const lx0 = Math.max(0, (view.x0 - r.x) * target);
			const ly0 = Math.max(0, (view.y0 - r.y) * target);
			const lx1 = Math.min(pw, (view.x1 - r.x) * target);
			const ly1 = Math.min(ph, (view.y1 - r.y) * target);
			for (let ty = Math.floor(ly0 / TILE); ty * TILE < ly1; ty++) {
				for (let tx = Math.floor(lx0 / TILE); tx * TILE < lx1; tx++) {
					need++;
					if (this.tiles.get(this.tileKey(p, target, tx * TILE, ty * TILE))?.tex) have++;
				}
			}
		}
		return need ? have / need : 1;
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
					// A flight in progress re-aims at the same rect in the new viewport.
					const f = this.flight;
					const next = f?.retarget();
					if (f && next) {
						f.to = next.cam;
						f.fit = next.fit;
					}
				}
				// Resizing clears the drawing buffer: draw synchronously so the
				// new size never shows an empty frame.
				this.dirty = true;
				this.frame(performance.now());
				this.emit({ type: "resized", w: msg.w, h: msg.h });
				return;
			}
			case "wheel": {
				this.cancelFlight();
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
				this.cancelFlight();
				if (msg.phase === "start") this.gestureZoom = this.cam.zoom;
				else if (msg.phase === "change" && this.gestureZoom !== null) this.userZoom(this.gestureZoom * msg.scale, msg.x, msg.y);
				else this.gestureZoom = null;
				return;
			}
			case "pointer":
				if (msg.phase === "down") this.cancelFlight();
				if (msg.kind === "touch") this.touch(msg);
				else this.mouse(msg);
				return;
			case "key":
				this.cancelFlight();
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
			this.command({ type: "goto", page: link.dest.page, top: link.dest.top, animate: true });
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
		else if (msg.mod && (msg.key === "a" || msg.key === "A")) void this.selectAll("auto");
	}

	/**
	 * Cmd/Ctrl+A: the page in view first; again (that page already selected)
	 * extends to the whole document, loading every page's text.
	 */
	private async selectAll(scope: "page" | "document" | "auto") {
		if (!this.pages.length) return;
		const view = this.viewRect();
		const page = this.pageAtDocY((view.y0 + view.y1) / 2);
		const current = await this.loadText(page);
		const pageSelected =
			this.selRange && comparePoints(this.selRange[0], { page, index: 0 }) <= 0 && comparePoints(this.selRange[1], { page, index: current.length }) >= 0;
		if (scope === "page" || (scope === "auto" && !pageSelected)) {
			this.handles = false;
			this.selectRange(page, 0, current.length);
			return;
		}
		const last = this.pages.length - 1;
		const texts = await Promise.all(this.pages.map((_, i) => this.loadText(i)));
		this.handles = false;
		this.selAnchor = [
			{ page: 0, index: 0 },
			{ page: 0, index: 0 },
		];
		this.setRange([
			{ page: 0, index: 0 },
			{ page: last, index: texts[last]!.length },
		]);
		this.emitSelection(true);
	}

	command(cmd: Command) {
		switch (cmd.type) {
			case "zoom":
				this.cancelFlight();
				this.userZoom(cmd.zoom, cmd.x ?? this.vw / 2, cmd.y ?? this.vh / 2);
				return;
			case "fit-width":
				this.cancelFlight();
				this.zoomAt(this.fitZoom(), this.vw / 2, 0);
				this.fitMode = true;
				return;
			case "goto": {
				const { page, top } = cmd;
				this.fly(cmd.flight ?? 0, cmd.animate ?? false, () => this.gotoTarget(page, top));
				return;
			}
			case "reveal": {
				const { page, rect, align, ifNeeded } = cmd;
				let first = true;
				// ifNeeded only applies to the first aim; a resize re-aims for real.
				this.fly(cmd.flight ?? 0, cmd.animate ?? false, () => {
					const t = this.revealTarget(page, rect, align, first && ifNeeded);
					first = false;
					return t;
				});
				return;
			}
			case "highlights": {
				const now = performance.now();
				const born = new Map<string, number>();
				for (const h of cmd.items) born.set(h.id, this.born.get(h.id) ?? now);
				this.born = born;
				// A finished flash keeps its highlight hidden until the host removes it.
				for (const [id, p] of this.pulses) if (!born.has(id) && now - p.start > p.dur) this.pulses.delete(id);
				this.highlights = cmd.items;
				this.requestFrame();
				return;
			}
			case "pulse": {
				const now = performance.now();
				const kind = cmd.kind ?? "ripple";
				const dur = cmd.duration ?? (kind === "flash" ? FLASH_MS : RIPPLE_MS);
				for (const id of cmd.ids) this.pulses.set(id, { kind, start: now, dur });
				this.requestFrame();
				return;
			}
			case "select":
				void this.selectPoints({ page: cmd.page, index: cmd.from }, { page: cmd.page, index: cmd.to });
				return;
			case "set-selection":
				if (cmd.range) void this.selectPoints(cmd.range.start, cmd.range.end);
				else this.clearSelection();
				return;
			case "cancel":
				this.cancelled.add(cmd.id);
				return;
			case "request":
				this.answer(cmd.request, cmd.id).then(
					(result) => this.emit({ type: "response", id: cmd.id, result }),
					(err) => this.emit({ type: "response", id: cmd.id, result: { error: String(err) } }),
				);
				return;
			case "clear-selection":
				this.clearSelection();
				return;
			case "unlock":
				this.pool.unlock(cmd.password);
				return;
			case "scroll-by":
				this.cancelFlight();
				this.panBy(cmd.dx, cmd.dy);
				return;
			case "select-all":
				void this.selectAll(cmd.scope ?? "auto");
				return;
			case "options": {
				const copyChanged = "copyOptions" in cmd.options && JSON.stringify(cmd.options.copyOptions) !== JSON.stringify(this.opts.copyOptions);
				this.opts = { ...this.opts, ...cmd.options };
				// The copied text follows the new options.
				if (copyChanged && this.selRange && !this.dragging) this.emitSelection(true);
				this.requestFrame();
				return;
			}
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

	private cancelled = new Set<number>();

	/**
	 * Searches pages in document order as their text arrives (a few pages are
	 * extracted ahead), so the first matches come back before the whole
	 * document is loaded. Matches may cross line and page breaks.
	 */
	private async runSearch(
		id: number,
		query: string,
		o: SearchOptions,
		fuzzy: boolean,
		onProgress: ((r: SearchResults) => void) | null,
	): Promise<SearchResults> {
		const pages = (o.pages ?? this.pages.map((_, i) => i)).filter((p) => p >= 0 && p < this.pages.length);
		const fold = { matchDiacritics: o.matchDiacritics, ignoreHyphenation: o.ignoreHyphenation };
		const q = foldQuery(query, o);
		const limit = Math.max(0, Math.floor(o.limit ?? 100));
		const threshold = Math.max(0, Math.min(1, o.threshold ?? 0.7));
		const maxDistance = fuzzy ? Math.floor(q.length * (1 - threshold)) : 0;
		const distance = maxDistance > 0 ? boundedDistance(q, maxDistance) : null;
		const exact: SearchHit[] = [];
		const fuzzyHits: SearchHit[] = [];
		let exactCount = 0;
		let fuzzyCount = 0;
		let searched = 0;
		const result = (done: boolean): SearchResults => {
			const { exactLimit, fuzzyLimit } = distance ? splitLimit(exactCount, fuzzyCount, limit) : { exactLimit: limit, fuzzyLimit: 0 };
			return {
				exactMatches: exact.slice(0, exactLimit),
				fuzzyMatches: fuzzyHits.slice(0, fuzzyLimit),
				hasMoreResults: exactCount + fuzzyCount > limit,
				pagesSearched: searched,
				pageCount: pages.length,
				done,
			};
		};
		if (!q) return result(true);
		const AHEAD = 6;
		let lastProgress = performance.now();
		let slice = performance.now();
		for (let i = 0; i < pages.length; i++) {
			if (this.cancelled.has(id)) throw new Error("cancelled");
			// Prefetch a window ahead (text jobs run behind visible tiles).
			for (let k = i; k < Math.min(pages.length, i + AHEAD); k++) if (!this.texts.has(pages[k]!)) this.requestText(pages[k]!, 500 + k);
			const page = pages[i]!;
			const text = await this.loadText(page);
			const hay = text.haystack(fold);
			// The next page's head, so a match can run across the page break.
			const nextPage = pages[i + 1] === page + 1 ? page + 1 : -1;
			let combined = hay.text;
			let sep = 0;
			let next: { text: PageText; map: Int32Array } | null = null;
			if (nextPage >= 0 && q.length > 1) {
				const nt = await this.loadText(nextPage);
				const nh = nt.haystack(fold);
				sep = hay.text.endsWith(" ") || !hay.text ? 0 : 1;
				combined = hay.text + (sep ? " " : "") + nh.text.slice(0, q.length * 2);
				next = { text: nt, map: nh.map };
			}
			const toHit = (m: RawMatch): SearchHit | null => {
				const pageLen = hay.text.length;
				if (!pageLen) return null;
				const from = hay.map[m.start]!;
				const to = hay.map[Math.min(m.end, pageLen) - 1]! + 1;
				const parts: SearchHit["parts"] = [{ page, index: from, length: to - from, rects: text.rects(from, to) }];
				let snippet = text.text(Math.max(0, from - 40), Math.min(text.length, to + 40));
				const tail = m.end - pageLen - sep;
				if (next && tail > 0) {
					const nFrom = next.map[0]!;
					const nTo = next.map[tail - 1]! + 1;
					parts.push({ page: nextPage, index: nFrom, length: nTo - nFrom, rects: next.text.rects(nFrom, nTo) });
					snippet = `${text.text(Math.max(0, from - 40), text.length).trimEnd()} ${next.text.text(nFrom, Math.min(next.text.length, nTo + 40))}`;
				}
				const first = parts[0]!;
				return { page, index: first.index, length: first.length, snippet, rects: first.rects, score: m.score, parts };
			};
			const found = matchPage(combined, hay.text.length, q, maxDistance, distance);
			let lastSpan = "";
			for (const m of found.exact) {
				const hit = toHit(m);
				if (!hit) continue;
				// "f" inside one "ﬀ" glyph: one highlight, not two.
				const span = `${hit.index}:${hit.length}`;
				if (span === lastSpan) continue;
				lastSpan = span;
				exactCount++;
				if (exact.length < limit) exact.push(hit);
			}
			for (const m of found.fuzzy) {
				fuzzyCount++;
				if (fuzzyHits.length < limit || m.score > (fuzzyHits[limit - 1]?.score ?? Infinity)) {
					const hit = toHit(m);
					if (hit) insertRanked(fuzzyHits, hit, limit);
				}
			}
			searched = i + 1;
			// Exact-only: the first extra hit proves hasMoreResults; later pages cannot change the list.
			if (!distance && exactCount > limit) {
				searched = pages.length;
				break;
			}
			const now = performance.now();
			if (onProgress && (now - lastProgress > 50 || found.exact.length || found.fuzzy.length)) {
				lastProgress = now;
				onProgress(result(false));
			}
			// Yield so frames (main-thread compositor) and input keep flowing.
			if (now - slice > 8) {
				await new Promise((r) => setTimeout(r, 0));
				slice = performance.now();
			}
		}
		return result(true);
	}

	private async answer(req: Request, id = 0): Promise<unknown> {
		switch (req.type) {
			case "page-text": {
				const text = await this.loadText(req.page);
				return text.text(0, text.length);
			}
			case "page-text-map": {
				const text = await this.loadText(req.page);
				return text.textWithMap();
			}
			case "rects": {
				const text = await this.loadText(req.page);
				return text.rects(req.from, req.to);
			}
			case "text-layer": {
				const text = await this.loadText(req.page);
				return text.layerLines();
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
				const r = await this.runSearch(id, req.query, { ...req, limit: req.limit ?? 500, threshold: 1 }, false, null).finally(() => this.cancelled.delete(id));
				return r.exactMatches;
			}
			case "search-results": {
				const progress = req.progress ? (results: SearchResults) => this.emit({ type: "search-progress", id, results }) : null;
				return this.runSearch(id, req.query, req, true, progress).finally(() => this.cancelled.delete(id));
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

	/**
	 * Programmatic selection between two caret positions. Text for every page
	 * in the range is loaded first, so a restored selection gets its rects and
	 * text even for pages that were never on screen.
	 */
	private async selectPoints(a: TextPoint, b: TextPoint) {
		const [s, e] = comparePoints(a, b) <= 0 ? [a, b] : [b, a];
		const last = this.pages.length - 1;
		if (last < 0) return;
		const s0 = Math.max(0, Math.min(last, s.page));
		const e0 = Math.max(0, Math.min(last, e.page));
		const texts = await Promise.all(Array.from({ length: e0 - s0 + 1 }, (_, i) => this.loadText(s0 + i)));
		const clamp = (p: number, i: number) => Math.max(0, Math.min(texts[p - s0]!.length, i));
		const start = { page: s0, index: clamp(s0, s.index) };
		const end = { page: e0, index: clamp(e0, e.index) };
		this.handles = false;
		this.selAnchor = [start, start];
		this.selRange = null; // recompute rects even if the range is unchanged
		this.setRange(comparePoints(start, end) === 0 ? null : [start, end]);
		this.emitSelection(true);
	}

	/** Programmatic selection of chars [from, to) on one page (text must be loaded). */
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
				range: { start: { ...this.selRange[0] }, end: { ...this.selRange[1] } },
				pages: this.selRects.map((p) => ({ page: p.page, rects: p.rects.map((r) => ({ ...r })) })),
				anchor: this.selectionScreenAnchor(),
			},
		});
	}

	private selectedText() {
		if (!this.selRange) return "";
		const copy = this.opts.copyOptions || {};
		const [s, e] = this.selRange;
		const parts: string[] = [];
		for (let page = s.page; page <= e.page; page++) {
			const text = this.texts.get(page);
			if (!text) continue;
			parts.push(text.text(page === s.page ? s.index : 0, page === e.page ? e.index : text.length, copy));
		}
		return parts.join(copy.lineBreaks === "space" ? " " : "\n");
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
			if (res.t !== "text") {
				// Extraction failed: the page has no text, and waiters (search) move on.
				if (res.t === "error") {
					this.texts.set(page, new PageText(new Uint32Array(0), new Float32Array(0)));
					for (const fn of this.textWaiters.get(page) ?? []) fn();
					this.textWaiters.delete(page);
				}
				return;
			}
			const r = res as TextResult;
			this.texts.set(page, new PageText(r.codes, r.boxes));
			this.links.set(page, r.links);
			if (r.images.length) {
				this.images.set(page, r.images);
				if (this.opts.dark) this.requestFrame();
			}
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

	private ensureTile(page: number, scale: number, x: number, y: number, w: number, h: number, priority: number, keep: Set<string>, pin = false) {
		const key = this.tileKey(page, scale, x, y);
		if (pin) this.pinned.add(key);
		const existing = this.tiles.get(key);
		if (existing) existing.lastWanted = this.frameId;
		if (existing && (existing.tex || existing.arrived || existing.failed)) return;
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
			if (res.t === "error") tile.failed = true;
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
	private viewRect(grow = 0, cam: Camera = this.cam) {
		const w = this.vw / cam.zoom;
		const h = this.vh / cam.zoom;
		return { x0: cam.x - w * grow, y0: cam.y - h * grow, x1: cam.x + w * (1 + grow), y1: cam.y + h * (1 + grow) };
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
		// A flight plans for where the camera is going, not where it is: the
		// destination's bitmaps and sharp tiles are fetched while it moves.
		const flight = this.flight;
		const cam = flight ? flight.to : this.cam;
		const S = cam.zoom * this.dpr;
		const zooming = !flight && now - this.lastZoomChange < ZOOM_SETTLE_MS;
		// While the zoom is moving, use a power-of-two pyramid so tiles are
		// reused across frames; once it settles, render at the exact scale.
		const raw = zooming ? 2 ** Math.ceil(Math.log2(S) - 0.05) : S;
		this.targetScale = Math.round(raw * 4096) / 4096;
		const keep = new Set<string>();
		this.pinned.clear();
		// Near the texture budget, keep what is cached ahead but stop fetching more.
		const roomAhead = this.gl.textureBytes < this.opts.textureBudgetMB * 1024 * 1024 * 0.8;
		const view = this.viewRect(0, cam);
		const ahead = this.viewRect(flight ? 0.25 : 0.75, cam);
		const visible = this.pagesIn(this.viewRect());
		const targetVisible = flight ? this.pagesIn(view) : visible;
		const near = this.pagesIn(ahead);
		const cx = (view.x0 + view.x1) / 2;
		const cy = (view.y0 + view.y1) / 2;
		const baseTile = (p: number, priority: number, pin = false) => {
			const s = this.baseScale(p);
			const size = this.pages[p]!;
			this.ensureTile(p, s, 0, 0, Math.round(size.w * s), Math.round(size.h * s), priority, keep, pin);
		};

		// 0. flight: base bitmaps along the path and at the destination (±1 page) first
		if (flight) {
			const want = new Set(flight.pages);
			for (const p of targetVisible) {
				want.add(p);
				if (p > 0) want.add(p - 1);
				if (p < this.layout.length - 1) want.add(p + 1);
			}
			for (const p of want) baseTile(p, -1 + Math.abs(this.layout[p]!.y + this.layout[p]!.h / 2 - cy) / 1e6, true);
			for (const p of targetVisible) this.requestText(p, 5);
		}

		// 1. a whole-page base bitmap for everything near the viewport: never blank
		const first = Math.max(0, (near[0] ?? 0) - 3);
		const last = Math.min(this.layout.length - 1, (near[near.length - 1] ?? 0) + 3);
		for (let p = first; p <= last; p++) baseTile(p, Math.abs(this.layout[p]!.y + this.layout[p]!.h / 2 - cy) / 1e6);

		// 2. sharp tiles: visible first (by distance from centre), then look-ahead.
		// In flight, what passes by mid-way comes after the destination.
		const passing = flight && flight.to.zoom === this.cam.zoom ? ([visible, this.viewRect(), 20] as const) : null;
		for (const [pages, region, base] of [[targetVisible, view, 10] as const, ...(passing ? [passing] : []), [near, ahead, 30] as const]) {
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
						if (base !== 10 && !roomAhead && !this.tiles.has(this.tileKey(p, s, x, y))) continue;
						const prio = base + Math.hypot(dx, dy) * cam.zoom * 1e-4;
						this.ensureTile(p, s, x, y, Math.min(TILE, pw - x), Math.min(TILE, ph - y), prio, keep, !!flight && base === 10);
					}
				}
			}
		}
		this.pool.retain(keep);
		this.pool.pump();
		// Placeholder tiles that will never be rendered are forgotten.
		for (const tile of this.tiles.values()) {
			if (!tile.tex && !tile.arrived && !tile.failed && !keep.has(tile.key) && !this.pool.has(tile.key)) this.dropTile(tile);
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
		// Still over: give up look-ahead tiles too (never what is on screen, nor a
		// flight's destination).
		if (this.gl.textureBytes <= budget) return;
		const ahead = [...this.tiles.values()]
			.filter((t) => t.tex && t.lastUsed !== frameId && !this.pinned.has(t.key))
			.sort((a, b) => a.lastUsed - b.lastUsed);
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

		let moving = this.stepFlight(now);
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
		this.draw(visible, now);
		if (this.marksAnimating(now)) moving = true;
		this.evict(this.frameId);

		this.cpuTimes.push(performance.now() - cpu0);
		this.reportView(visible);
		this.reportStats(now);

		this.animating = moving || this.arrived.length > 0 || this.dirty;
		if (this.animating) this.requestFrame();
	}

	/** Highlight opacity from its fade-in and any flash pulse. */
	private markAlpha(id: string, now: number) {
		let a = 1;
		const born = this.born.get(id);
		if (born !== undefined && now - born < FADE_IN_MS) a *= easeOutCubic(Math.max(0, now - born) / FADE_IN_MS);
		const p = this.pulses.get(id);
		if (p?.kind === "flash") a *= flashCurve(Math.max(0, now - p.start) / p.dur);
		return a;
	}

	private marksAnimating(now: number) {
		for (const born of this.born.values()) if (now - born < FADE_IN_MS) return true;
		for (const [id, p] of this.pulses) {
			if (now - p.start < p.dur) return true;
			if (p.kind === "ripple") this.pulses.delete(id);
		}
		return false;
	}

	private draw(visible: number[], now: number) {
		const gl = this.gl;
		const S = this.cam.zoom * this.dpr;
		const target = this.targetScale;
		const { background, selectionColor, selectionColorDark, highlightColor, gamma, dark, paper, ink } = this.opts;
		gl.setTone(dark ? { paper, ink } : null);
		// Marks sit behind the text in both modes. Light: multiply, so black ink
		// stays black. Dark: lighten (per-channel max), so the dark paper takes
		// the colour while light ink stays on top, untinted.
		// Light: the colour composited over white, so alpha still reads as strength.
		// Dark: a deep version of the colour over the paper, so light ink keeps its
		// contrast. Alpha is boosted: light-mode alphas (~0.35) read too faint on dark.
		const mark = (c: Color, dark: boolean): Color => {
			if (!dark) return [1 - c[3] * (1 - c[0]), 1 - c[3] * (1 - c[1]), 1 - c[3] * (1 - c[2]), 1];
			const a = Math.min(1, c[3] * 1.8);
			return [paper[0] + (c[0] * 0.55 - paper[0]) * a, paper[1] + (c[1] * 0.55 - paper[1]) * a, paper[2] + (c[2] * 0.55 - paper[2]) * a, 1];
		};
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
			const drawTiles = () => {
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
			};
			const drawMarks = (dark: boolean) => {
				const markBlend = dark ? "lighten" : "multiply";
				const drawHighlight = (h: Highlight, alpha: number, grow: number) => {
					if (alpha <= 0.002) return;
					const base = h.color ?? highlightColor;
					const c: Color = [base[0], base[1], base[2], base[3] * alpha];
					const color = mark(c, dark);
					const style = h.style ?? "fill";
					// A ripple grows each rect outward by `grow` points, except on sides
					// that touch the next line (overlapping fills would stripe).
					const touches = (q: Rect, edge: "top" | "bottom") =>
						h.rects.some(
							(o) => o !== q && o.x < q.x + q.w && q.x < o.x + o.w && Math.abs(edge === "top" ? o.y + o.h - q.y : q.y + q.h - o.y) < 1,
						);
					for (const q of h.rects) {
						let x = sx + q.x * S;
						let y = sy + q.y * S;
						let w = q.w * S;
						let hh = q.h * S;
						if (grow > 0) {
							const g = grow * S;
							const gt = touches(q, "top") ? 0 : g;
							const gb = touches(q, "bottom") ? 0 : g;
							x -= g;
							w += 2 * g;
							y -= gt;
							hh += gt + gb;
						}
						if (style === "fill") gl.drawRect(x, y, w, hh, color, markBlend);
						else if (style === "underline") gl.drawRect(x, y + hh - 2 * px, w, 2 * px, c, "alpha");
						else {
							const b = 2 * px;
							gl.drawRect(x - b, y - b, w + 2 * b, b, c, "alpha");
							gl.drawRect(x - b, y + hh, w + 2 * b, b, c, "alpha");
							gl.drawRect(x - b, y, b, hh, c, "alpha");
							gl.drawRect(x + w, y, b, hh, c, "alpha");
						}
					}
				};
				for (const h of this.highlights) {
					if (h.page !== p) continue;
					const alpha = this.markAlpha(h.id, now);
					drawHighlight(h, alpha, 0);
					const pulse = this.pulses.get(h.id);
					if (pulse?.kind !== "ripple") continue;
					const t = Math.max(0, now - pulse.start) / pulse.dur;
					if (t >= 1) continue;
					// Outward expansion plus fade: up to ~12% of the highlight's size.
					const e = easeOutCubic(t);
					let x0 = Infinity;
					let y0 = Infinity;
					let x1 = -Infinity;
					let y1 = -Infinity;
					for (const q of h.rects) {
						x0 = Math.min(x0, q.x);
						y0 = Math.min(y0, q.y);
						x1 = Math.max(x1, q.x + q.w);
						y1 = Math.max(y1, q.y + q.h);
					}
					const size = Math.min(16, Math.max(3, 0.06 * Math.sqrt(Math.max(0, (x1 - x0) * (y1 - y0)))));
					drawHighlight(h, alpha * (1 - e), size * e);
				}
				for (const sel of this.selRects) {
					if (sel.page !== p) continue;
					const c = dark ? selectionColorDark : mark(selectionColor, false);
					for (const q of sel.rects) gl.drawRect(sx + q.x * S, sy + q.y * S, q.w * S, q.h * S, c, markBlend);
				}
			};
			drawTiles();
			drawMarks(dark);
			// Dark mode recolours vector content and scans: photos are drawn again,
			// clipped to their boxes, without the tone mapping. They keep their
			// original (usually light) colours, so marks there use the light style.
			// Scan paper is not in `images` (the worker classifies it), so a
			// scanned page darkens like any other and its marks use the dark style.
			const images = dark ? this.images.get(p) : undefined;
			if (images) {
				gl.setTone(null);
				for (let i = 0; i < images.length; i += 4) {
					const l = Math.max(0, images[i]!);
					const t = Math.max(0, images[i + 1]!);
					const rr = Math.min(r.w, images[i + 2]!);
					const b = Math.min(r.h, images[i + 3]!);
					if (rr <= l || b <= t || rr < vx0 || l > vx1 || b < vy0 || t > vy1) continue;
					gl.clip({ x: sx + l * S, y: sy + t * S, w: (rr - l) * S, h: (b - t) * S });
					drawTiles();
					drawMarks(false);
				}
				gl.clip(null);
				gl.setTone({ paper, ink });
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
		if (page === this.lastView.page && this.cam.zoom === this.lastView.zoom && this.fitMode === this.lastView.fit) return;
		this.lastView = { page, zoom: this.cam.zoom, fit: this.fitMode };
		this.emit({ type: "view", zoom: this.cam.zoom, page, pageCount: this.pages.length, fitWidth: this.fitMode });
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
