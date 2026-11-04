// The viewer core. It owns the camera, page layout, tile pyramid, text
// selection and the WebGL frame loop. It never touches the DOM, so the same
// code runs on the main thread or inside a worker with an OffscreenCanvas.

import { markColor } from "./colors";
import { Compositor } from "./gl";
import { anchoredY, buildLayout, estimateSizes } from "./layout";
import { uploadRank } from "./upload-rank";
import type { DocumentInfo, ErrorCode, ErrorPhase, Link, LoadFailureDetail, OpenTiming, OutlineItem, PageSize, SizeEntry } from "./protocol";
import { RasterPool, type SizesResult, type TextResult, type TileResult } from "./raster-pool";
import { TileCache } from "./tile-cache";
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
	/** "fit-width", "fit-page" (a whole page in view) or a zoom factor */
	initialZoom: "fit-width" | "fit-page" | number;
	/** page (0-based) shown first, set before the first paint (default 0) */
	initialPage: number;
	/**
	 * Where the first view starts: page points below the top of `initialPage`
	 * (default 0, the page top with a `pageGap` margin). See also
	 * `initialOffset` and `initialCamera`.
	 */
	initialTop: number;
	/**
	 * Restore a scroll position: css px from the top of the document at the
	 * initial zoom, like lector's `initialOffset` (pairs with
	 * `viewer.scrollState().top`). Wins over `initialPage`.
	 */
	initialOffset: number | null;
	/** exact restore of a saved `camera` event (doc points + zoom); wins over the other initial options */
	initialCamera: Camera | null;
	/**
	 * Where the first view opens, before the first paint; wins over
	 * `initialPage`/`initialTop`/`initialOffset`. With range loading, this
	 * page (and its neighbours) is fetched and drawn first.
	 * - `{ page, top? }`: points below the page top; `{ page, topFraction }`: that fraction of the page's height
	 * - `{ fraction }`: like `scrollToFraction` (0-1 of the scrollable height)
	 * - `{ page, rect, align?, units? }`: like `reveal` (a citation); `units: "fraction"` for a rect in 0-1 of the page
	 */
	initialTarget: InitialTarget | null;
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

/** Every option's default (hosts can read `pageGap`, colours, ... from here or `viewer.options`). */
export const defaultOptions: CoreOptions = {
	background: [0.93, 0.93, 0.94],
	pageGap: 12,
	selectionColor: [0.62, 0.78, 1, 1],
	selectionColorDark: [0.16, 0.31, 0.58, 1],
	highlightColor: [1, 0.9, 0.4, 1],
	gamma: 1.25,
	textureBudgetMB: 384,
	initialZoom: "fit-width",
	initialPage: 0,
	initialTop: 0,
	initialOffset: null,
	initialCamera: null,
	initialTarget: null,
	minZoom: 0.1,
	maxZoom: 24,
	dark: false,
	paper: [0.12, 0.12, 0.13],
	ink: [0.88, 0.88, 0.86],
	reducedMotion: false,
	copyOptions: {},
};

/** `units: "fraction"`: the rect is 0-1 of the page (its size is not known before the document opens) */
export type InitialTarget =
	| { page: number; top?: number; topFraction?: number }
	| { fraction: number }
	| { page: number; rect: Rect; align?: RevealAlign; units?: "points" | "fraction" };

export type PointerKind = "mouse" | "touch" | "pen";

/**
 * Why a flight did not land: `input` (wheel, gesture, pointer down or key on the
 * viewer), `command` (the host sent zoom/fit/scroll), `jump` (a newer
 * goto/reveal), `no-target` (the destination does not exist: no such page,
 * or a non-finite rect).
 */
export type FlightCause = "input" | "command" | "jump" | "no-target";

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
			/** the browser's first active touch: no other finger is down */
			primary?: boolean;
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
	/** [start, end) of the match within `snippet` (UTF-16 offsets), for highlighting it */
	snippetMatch: [number, number];
	/** 1 for exact matches, else 1 - edits/query length */
	score: number;
	/** an exact (folded) match, not a fuzzy one */
	exact: boolean;
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
	| {
			type: "search";
			query: string;
			limit?: number;
			pages?: number[];
			matchDiacritics?: boolean;
			ignoreHyphenation?: boolean;
			/** also return fuzzy matches (after the exact ones, best first) */
			fuzzy?: { threshold?: number };
	  }
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
	/** zoom so the page in view fits whole, centred */
	| { type: "fit-page" }
	/** scroll so the viewport top is at `fraction` (0-1) of the scrollable height */
	| { type: "scroll-to"; fraction: number }
	/** workers read the document over the network (true) or have the whole file (false) */
	| { type: "remote"; on: boolean }
	/** `flight`: id echoed in the `flight` event when the camera lands (or is interrupted) */
	| { type: "goto"; page: number; top?: number; animate?: boolean; flight?: number; offset?: number }
	/**
	 * Bring `rect` (page points) into view: its top lands at `align` (default 0.3 of
	 * the viewport height), x only moves if it does not fit, and the zoom only drops
	 * if the rect is taller than 80% of the viewport. `ifNeeded`: no move when the
	 * rect is already fully visible.
	 */
	| { type: "reveal"; page: number; rect: Rect; animate?: boolean; align?: RevealAlign; ifNeeded?: boolean; flight?: number; offset?: number }
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
	| { type: "options"; options: Partial<CoreOptions> }
	/** keep base page bitmaps in a persistent cache under this document key (see the viewer's `tileCache` option) */
	| { type: "tile-cache"; key: string; budgetMB: number };

/**
 * Frame statistics over the last ~500ms. A frame is "wanted" when something
 * asked for it: continuous motion (the previous frame asked for the next one)
 * or an input, tile or command after idle. Frame times are measured from the
 * moment a frame was wanted, so idle time between interactions never counts.
 */
export interface Stats {
	/** frames per second during continuous motion (0 when idle) */
	fps: number;
	/** 95th percentile interval between consecutive frames of continuous motion */
	p95FrameMs: number;
	/** slowest frame in the window, from wanted to drawn (uncapped) */
	worstFrameMs: number;
	/** frames drawn in the window */
	frames: number;
	/** frames drawn more than 33ms after they were wanted (one dropped vsync at 60Hz) */
	framesOver33: number;
	framesOver50: number;
	framesOver100: number;
	/** tile pixels uploaded to the GPU in the busiest frame of the window */
	uploadPeakBytes: number;
	avgCpuMs: number;
	tiles: number;
	textureMB: number;
	pendingJobs: number;
	avgTileMs: number;
	targetScale: number;
	workers: number;
	/** PDFium memory across raster workers (WASM heaps + block caches) */
	workerMB: number;
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
	/**
	 * the document opened: page sizes (points), their layout in doc space, and its metadata.
	 * `complete: false` (range loading): some sizes are estimates; `layout` events follow as they resolve.
	 */
	| { type: "ready"; pages: PageSize[]; layout: Rect[]; info: DocumentInfo; complete: boolean; timing?: OpenTiming }
	/** estimated page sizes resolved (range loading); the camera kept the content in view where it was */
	| { type: "layout"; pages: PageSize[]; layout: Rect[]; complete: boolean }
	/** the first page bitmap reached the screen (once per document) */
	| { type: "painted"; page: number; timing?: { firstTileAt: number; paintedAt: number; cacheHits: number } }
	/** `fitWidth`: fit-width mode (kept for compatibility); `fit`: the sticky fit mode, if any */
	| { type: "view"; zoom: number; page: number; pageCount: number; fitWidth: boolean; fit: "width" | "page" | null }
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
	/** the browser restored a lost WebGL context (after a `gpu`/`render` error); tiles are redrawing */
	| { type: "restored" }
	/**
	 * An animated (or instant) reveal/goto finished. `landed: false` comes with a
	 * `cause` (see FlightCause). `coverage`: share of the landing view already
	 * covered by sharp tiles; `waitMs`: how long the flight waited for bitmaps
	 * (or for the view to get a size: a goto/reveal before `ready` or while the
	 * container is hidden waits, then lands instantly).
	 */
	| { type: "flight"; id: number; landed: boolean; cause?: FlightCause; coverage: number; waitMs: number; durationMs: number }
	| { type: "stats"; stats: Stats }
	/**
	 * The view became sharp after a zoom or a jump: every visible page is drawn
	 * at the target scale. `ms` counts from the last zoom step, or from the
	 * moment a jump landed.
	 */
	| { type: "sharp"; cause: "zoom" | "jump"; ms: number }
	/** emitted by the viewer once, right after the first `painted` */
	| { type: "load"; timings: LoadTimings }
	/** `code`/`phase` say what failed and when (see ErrorCode, ErrorPhase) */
	| { type: "error"; message: string; code: ErrorCode; phase: ErrorPhase; detail?: LoadFailureDetail };

/** epoch ms (timeOrigin + now), comparable across the main thread and workers */
export const epochNow = () => performance.timeOrigin + performance.now();

/** Where the time to first paint went. Durations in ms; `readyMs` and later count from `createViewer`. */
export interface LoadTimings extends Partial<OpenTiming> {
	/** downloading the document before opening (with range loading: the probe and seeds, or the whole small file; 0 for in-memory sources) */
	fetchMs: number;
	fetchBytes: number;
	/** waiting for the shared pdfium.wasm compile (`preloadPdfium`) */
	wasmWaitMs: number;
	/** spawning the first raster worker until its script ran */
	workerBootMs: number;
	readyMs: number;
	/** the first tile bitmap was ready: rendered by PDFium, or read from the `tileCache` */
	firstTileMs: number;
	firstPaintMs: number;
	/** tiles served from the `tileCache` by the first paint (0 without one) */
	tileCacheHits: number;
	/** the document opened from range requests (`loadMode: "range"`) */
	rangeLoading: boolean;
	/** memory: ArrayBuffer source; download: one plain GET; whole: the range probe found a small file and read it in that one response; range: block reads */
	loadMode: "memory" | "download" | "whole" | "range";
	/** document size (0 when unknown) */
	fileKB: number;
	/** PDF requests before the first paint: probe, HEAD, seeds and the workers' range reads */
	requestsBeforePaint: number;
	/** PDF bytes downloaded before the first paint */
	kbBeforePaint: number;
	/** `createViewer` until the first PDF response headers (0 for in-memory sources) */
	ttfbMs: number;
}

/** frames later than this were suspended (hidden tab), not slow */
const SUSPENDED_MS = 2000;

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
	/** being read from the persistent cache */
	loading?: boolean;
}

interface PageRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const TILE = 512;
const BASE_MAX = 1024;
/** base bitmaps that took longer than this (ms) go to the persistent cache */
const CACHE_MIN_MS = 20;
/** cache writes wait until no frame has run for this long (ms) */
const CACHE_IDLE_MS = 400;
/** a page whose base bitmap is predicted slower than this gets a quick low-res preview first */
const PREVIEW_MS = 50;
/** preview scale = base scale / PREVIEW_DIV (1/16 of the pixels) */
const PREVIEW_DIV = 4;
const ZOOM_SETTLE_MS = 180;
const UPLOAD_BUDGET_MS = 2.5;
/** per-frame texture upload budget (bytes): halves after a late frame, grows while frames are on time */
const UPLOAD_MIN = TILE * TILE * 4;
const UPLOAD_MAX = 64 * 1024 * 1024;
/** at most this much texture memory is freed per frame below the hard budget */
const EVICT_STEP = 16 * 1024 * 1024;
const CLICK_SLOP = 4;
const AUTOSCROLL_EDGE = 48;
const LONG_PRESS_MS = 450;
const TOUCH_SLOP = 8;
/** handle knob radius and touch target, css px */
const HANDLE_R = 6;
const HANDLE_HIT = 32;
/** a flight waits this long at most for destination bitmaps before it starts */
const FLIGHT_WAIT_MS = 80;
/** pages per background `sizes` job (the worker answers early after a few ms) */
const SIZES_BATCH = 48;
/** jumps longer than this many viewports cut to one viewport short, then ease in */
const FLIGHT_TELEPORT = 3;
/** css px kept between a revealed rect and the viewport edge */
const REVEAL_MARGIN = 24;
const FADE_IN_MS = 150;
const RIPPLE_MS = 1000;
const FLASH_MS = 1200;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const PAGE_EDGE: Color = [0, 0, 0, 0.12];
const WHITE: Color = [1, 1, 1, 1];

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

type Fit = false | "width" | "page";

interface Flight {
	/** host id echoed in the `flight` event; 0 for internal jumps (links) */
	id: number;
	from: Camera;
	to: Camera;
	/** fit mode once landed */
	fit: Fit;
	requested: number;
	/** frame time the motion began; -1 while waiting for destination bitmaps */
	start: number;
	dur: number;
	/** pages on the path and at the destination: their base bitmaps must be ready */
	pages: number[];
	/** recomputes the destination (after a resize) */
	retarget: () => { cam: Camera; fit: Fit } | null;
}

/** A goto/reveal asked for while the view cannot place a camera (not open yet, or 0 px wide/tall). */
interface PendingJump {
	id: number;
	requested: number;
	retarget: Flight["retarget"];
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
	/** the last width with a measurable view: a hidden viewer keeps its camera for that size */
	private measuredW = 0;
	/** fit-width/fit-page is sticky across resizes until the user zooms by hand */
	private fitMode: Fit = false;

	private pages: PageSize[] = [];
	/** sizes not read yet (range loading): laid out as a neighbour's size, never rasterised */
	private estimated: boolean[] = [];
	private unknown = 0;
	/** page -> key of the `sizes` job that will read it */
	private sizesWanted = new Map<number, string>();
	private sizesPriority = new Map<string, number>();
	/** a `scroll-to` (or initial fraction) made with estimated sizes: re-applied as they resolve, until the reader moves */
	private pendingFraction: number | null = null;
	private layout: PageRect[] = [];
	private docW = 0;
	private docH = 0;

	private tiles = new Map<string, Tile>();
	private tilesByPage = new Map<number, Set<Tile>>();
	private arrived: { tile: Tile; pixels: Uint8Array | ImageBitmap }[] = [];
	private cache: TileCache | null = null;
	private targetScale = 1;
	private lastZoomChange = -1e9;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;

	private texts = new Map<number, PageText>();
	/** page -> priority of its queued text job */
	private textPending = new Map<number, number>();
	/** raster image boxes per page (l, t, r, b in points), kept in original colours in dark mode */
	private images = new Map<number, Float32Array>();
	private links = new Map<number, Link[]>();
	private textWaiters = new Map<number, (() => void)[]>();

	// selection
	private selAnchor: [TextPoint, TextPoint] | null = null;
	private selRange: [TextPoint, TextPoint] | null = null;
	private selUnit: "char" | "word" | "line" = "char";
	/**
	 * Bumped by every selection change: programmatic selections that wait for
	 * text give up if the selection changed meanwhile (newer intent wins).
	 */
	private selGen = 0;
	private selRects: { page: number; rects: Rect[] }[] = [];
	private dragging = false;
	private pointer = { x: 0, y: 0 };
	private downAt: { x: number; y: number } | null = null;
	/** a mouse press on a page whose text had not arrived: anchored once it does (doc points) */
	private pendingPress: {
		page: number;
		x: number;
		y: number;
		clicks: number;
		shift: boolean;
		gen: number;
		release: { x: number; y: number } | null;
		/** the anchor is set; only the release point's page was still loading */
		anchored?: boolean;
	} | null = null;
	private cursor: Cursor = "default";
	private hovered: string | null = null;

	private highlights: Highlight[] = [];
	/** when each highlight id first appeared (for the fade-in) */
	private born = new Map<string, number>();
	private pulses = new Map<string, { kind: PulseKind; start: number; dur: number }>();

	private flight: Flight | null = null;
	private pending: PendingJump | null = null;
	/** tiles a flight needs at its destination: eviction never drops these */
	private pinned = new Set<string>();

	// touch
	private touches = new Map<number, { x: number; y: number }>();
	private pinch: { dist: number; zoom: number; cx: number; cy: number } | null = null;
	private velocity = { x: 0, y: 0 };
	private samples: { t: number; x: number; y: number }[] = [];
	private gestureZoom: number | null = null;
	private press: { x: number; y: number; t: number; timer: ReturnType<typeof setTimeout> | null; waitingText?: number } | null = null;
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
	/** benches only (`debugProbe`): every finished tile job since the last probe */
	private tileLog: { page: number; base: boolean; ms: number; waitMs: number }[] = [];
	private lastStats = 0;
	private inFrame = false;
	private frameEnd = 0;
	/** when the scheduled frame was first wanted; the previous frame's start for continuous motion */
	private wantedAt = 0;
	private windowFrames = 0;
	private worstFrame = 0;
	private over33 = 0;
	private over50 = 0;
	private over100 = 0;
	private uploadPeak = 0;
	private uploadBudget = 8 * 1024 * 1024;
	private uploadedLast = 0;
	/** shortest recent continuous frame interval: the display's refresh interval */
	private vsync = 1000 / 60;
	private firstTileAt = 0;
	private cacheHits = 0;
	private sharpWait: { cause: "zoom" | "jump"; since: number } | null = null;
	private lastView: { zoom: number; page: number; fit: Fit } = { zoom: 0, page: -1, fit: false };

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
		this.pool.onOpened = (pageCount, sizes, info, timing) => this.opened(pageCount, sizes, info, timing);
		this.pool.onError = (message, code, phase, detail) => this.emit({ type: "error", message, code, phase, ...(detail && { detail }) });
		this.gl.onLost = () => this.emit({ type: "error", message: "lector-engine: the WebGL context was lost; waiting for the browser to restore it", code: "gpu", phase: "render" });
		this.gl.onRestored = () => this.contextRestored();
	}

	private disposed = false;

	/**
	 * Stops the frame loop and timers, closes the worker ports and frees GPU
	 * resources. The core is unusable afterwards; requests in flight never answer.
	 */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.flight = null;
		this.pending = null;
		this.dragging = false;
		this.velocity = { x: 0, y: 0 };
		for (const timer of [this.settleTimer, this.idleTimer, this.cacheTimer, this.press?.timer]) if (timer) clearTimeout(timer);
		this.settleTimer = this.idleTimer = this.cacheTimer = null;
		this.press = null;
		this.pool.dispose();
		for (const tile of this.tiles.values()) if (tile.tex) this.gl.free(tile.tex, tile.w, tile.h);
		this.tiles.clear();
		this.tilesByPage.clear();
		for (const { pixels } of this.arrived) if (!(pixels instanceof Uint8Array)) pixels.close();
		this.arrived = [];
		this.texts.clear();
		this.textWaiters.clear();
		this.gl.dispose();
		this.emit = () => {};
	}

	/** Every texture died with the old context: tiles are fetched again; pixels waiting for upload are kept. */
	private contextRestored() {
		if (this.disposed) return;
		for (const tile of this.tiles.values()) tile.tex = null;
		this.requestFrame();
		this.emit({ type: "restored" });
	}

	// ---------------------------------------------------------------- setup

	private opened(pageCount: number, entries: SizeEntry[], info: DocumentInfo, timing?: OpenTiming) {
		const known: (PageSize | null)[] = new Array(pageCount).fill(null);
		for (const [i, w, h] of entries) if (i >= 0 && i < pageCount) known[i] = { w, h };
		const { sizes, estimated } = estimateSizes(known);
		this.pages = sizes;
		this.estimated = estimated;
		this.unknown = estimated.filter(Boolean).length;
		this.relayout();
		this.emit({ type: "ready", pages: this.pages.map((p) => ({ ...p })), layout: this.layout.map((r) => ({ ...r })), info, complete: this.unknown === 0, timing });
		this.initCamera();
		this.requestFrame();
	}

	private relayout() {
		const { rects, docW, docH } = buildLayout(this.pages, this.opts.pageGap);
		this.layout = rects;
		this.docW = docW;
		this.docH = docH;
	}

	/** Real sizes replace estimates; what is on screen stays where it is. */
	private applySizes(entries: SizeEntry[]) {
		let changed = false;
		const resolved: number[] = [];
		for (const [i, w, h] of entries) {
			this.sizesWanted.delete(i);
			if (!this.estimated[i]) continue;
			this.estimated[i] = false;
			this.unknown--;
			resolved.push(i);
			const p = this.pages[i]!;
			if (p.w !== w || p.h !== h) changed = true;
			this.pages[i] = { w, h };
		}
		queueMicrotask(() => {
			for (const i of resolved) {
				for (const fn of this.sizeWaiters.get(i) ?? []) fn();
				this.sizeWaiters.delete(i);
			}
		});
		// Estimated pages after a resolved one take its size: the next real size is more likely that than the old guess.
		if (changed) {
			let last: PageSize | null = null;
			for (let i = 0; i < this.pages.length; i++) {
				if (!this.estimated[i]) last = this.pages[i]!;
				else if (last) this.pages[i] = last;
			}
		}
		if (!changed && this.unknown > 0) {
			// Same layout, but these pages may be drawn now.
			if (resolved.length) this.requestFrame();
			return;
		}
		const before = this.layout;
		this.relayout();
		if (changed && this.camReady) {
			const viewH = this.vh / this.cam.zoom;
			if (this.pendingFraction !== null) this.cam.y = this.pendingFraction * Math.max(0, this.docH - viewH);
			else this.cam.y = anchoredY(before, this.layout, this.cam.y, viewH);
			const f = this.flight;
			if (f) {
				f.from = { ...f.from, y: anchoredY(before, this.layout, f.from.y, this.vh / f.from.zoom) };
				const next = f.retarget();
				if (next) {
					f.to = next.cam;
					f.fit = next.fit;
				}
			}
			this.clampCamera();
		}
		if (this.unknown === 0) this.pendingFraction = null;
		this.emit({ type: "layout", pages: this.pages.map((p) => ({ ...p })), layout: this.layout.map((r) => ({ ...r })), complete: this.unknown === 0 });
		this.requestFrame();
	}

	/** Asks for real sizes: pages in view first, then the rest in the background, nearest first. */
	private requestSizes(pages: number[], priority: number) {
		const want: number[] = [];
		for (const p of pages) {
			if (!this.estimated[p]) continue;
			const queued = this.sizesWanted.get(p);
			// Already in a job: make that job as urgent as this ask.
			if (queued && priority < (this.sizesPriority.get(queued) ?? 0)) {
				this.sizesPriority.set(queued, priority);
				this.pool.request(queued, priority, { t: "sizes", page: -1, pages: [] }, () => {});
			} else if (!queued) want.push(p);
		}
		if (!want.length) return;
		const key = `sizes:${want[0]}`;
		for (const p of want) this.sizesWanted.set(p, key);
		this.sizesPriority.set(key, priority);
		this.pool.request(key, priority, { t: "sizes", page: -1, pages: want }, (res) => {
			this.sizesPriority.delete(key);
			for (const p of want) this.sizesWanted.delete(p);
			const sizes = res.t === "sizes" ? (res as SizesResult).sizes : [];
			this.applySizes(sizes);
			// The worker stopped early: pages in view ask again on the next frame.
			if (sizes.length < want.length) this.requestFrame();
			this.backgroundSizes(this.currentPage());
			this.pool.pump();
		});
	}

	private sizeWaiters = new Map<number, (() => void)[]>();

	private knownSize(page: number): Promise<void> {
		if (!this.estimated[page]) return Promise.resolve();
		return new Promise((resolve) => {
			const list = this.sizeWaiters.get(page) ?? [];
			list.push(resolve);
			this.sizeWaiters.set(page, list);
			this.requestSizes([page], 300);
			this.pool.pump();
		});
	}

	private backgroundSizes(center: number, priority = 700) {
		// Background reads wait for the first paint: they would share its bandwidth.
		if (this.unknown === 0 || (priority === 700 && (this.sizesWanted.size > 0 || !this.painted))) return;
		const out: number[] = [];
		for (let d = 0; out.length < SIZES_BATCH && d < this.pages.length; d++) {
			if (this.estimated[center + d] && !this.sizesWanted.has(center + d)) out.push(center + d);
			if (d > 0 && this.estimated[center - d] && !this.sizesWanted.has(center - d)) out.push(center - d);
		}
		this.requestSizes(out, priority);
	}

	/** The camera can be aimed: the document is laid out and the view has a size. */
	private canAim() {
		return this.camReady && this.vw > 0 && this.vh > 0;
	}

	private initCamera() {
		if (this.camReady || this.vw === 0 || this.vh === 0 || this.pages.length === 0) return;
		this.camReady = true;
		const o = this.opts;
		const initial = o.initialZoom;
		this.fitMode = initial === "fit-width" ? "width" : initial === "fit-page" ? "page" : false;
		const t = o.initialTarget;
		const wanted = t && "page" in t ? t.page : o.initialPage;
		const page = Math.max(0, Math.min(this.pages.length - 1, Math.floor(wanted) || 0));
		if (o.initialCamera) {
			this.fitMode = false;
			this.cam = { ...o.initialCamera, zoom: this.clampZoom(o.initialCamera.zoom) };
		} else {
			this.cam.zoom = this.clampZoom(this.fitMode ? this.fitZoom(this.fitMode, page) : (initial as number));
			const zoom = this.cam.zoom;
			const r = this.layout[page]!;
			if (t && "rect" in t) {
				const rect = t.units === "fraction" ? { x: t.rect.x * r.w, y: t.rect.y * r.h, w: t.rect.w * r.w, h: t.rect.h * r.h } : t.rect;
				const target = this.revealTarget(page, rect, t.align ?? "auto");
				if (target) {
					this.cam = target.cam;
					this.fitMode = target.fit;
				}
			} else if (t && "fraction" in t && Number.isFinite(t.fraction)) {
				const fraction = Math.max(0, Math.min(1, t.fraction));
				this.cam.y = fraction * Math.max(0, this.docH - this.vh / zoom);
				if (this.unknown > 0) this.pendingFraction = fraction;
			} else if (t && "page" in t) {
				const top = t.topFraction !== undefined && Number.isFinite(t.topFraction) ? t.topFraction * r.h : Number.isFinite(t.top) ? t.top! : 0;
				if (this.fitMode === "page" && !top) this.cam = this.fitPageCam(page, zoom);
				else this.cam.y = r.y + top - this.opts.pageGap;
			} else if (o.initialOffset != null) this.cam.y = o.initialOffset / zoom;
			else if (this.fitMode === "page") this.cam = this.fitPageCam(page, zoom);
			else this.cam.y = r.y + o.initialTop - this.opts.pageGap;
		}
		this.clampCamera();
		this.landPending();
	}

	/** Camera that centres `page` at `zoom`. */
	private fitPageCam(page: number, zoom: number): Camera {
		const r = this.layout[page]!;
		return { x: r.x + r.w / 2 - this.vw / 2 / zoom, y: r.y + r.h / 2 - this.vh / 2 / zoom, zoom };
	}

	// ---------------------------------------------------------------- camera

	/** Zoom for a fit mode: the widest page fits the width, or `page` fits whole (with the 16px margins). */
	private fitZoom(kind: "width" | "page" = "width", page = this.currentPage()) {
		const width = Math.min((this.vw - 32) / this.docW, 2);
		if (kind === "width") return width;
		const r = this.layout[page];
		if (!r) return width;
		return Math.min((this.vw - 32) / r.w, (this.vh - 2 * this.opts.pageGap) / r.h);
	}

	/** The page at the viewport's vertical centre. */
	private currentPage() {
		const v = this.viewRect();
		return this.layout.length ? this.pageAtDocY((v.y0 + v.y1) / 2) : 0;
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
	private revealTarget(page: number, rect: Rect, align: RevealAlign = "auto", ifNeeded = false, offset = 0): { cam: Camera; fit: Fit } | null {
		const r = this.layout[page];
		if (!r) return null;
		if (![rect.x, rect.y, rect.w, rect.h, offset].every(Number.isFinite)) return null;
		const m = REVEAL_MARGIN;
		const cur = this.cam;
		const dx0 = r.x + rect.x;
		const dy0 = r.y + rect.y;
		if (ifNeeded) {
			const v = this.viewRect();
			const mz = m / cur.zoom;
			if (dx0 >= v.x0 && dx0 + rect.w <= v.x1 && dy0 >= v.y0 + mz && dy0 + rect.h <= v.y1 - mz) return { cam: { ...cur }, fit: this.fitMode };
		}
		// Zoom out only when the rect cannot be read whole. Fit-page starts from
		// the zoom that fits the destination page.
		const base = this.fitMode === "page" ? this.clampZoom(this.fitZoom("page", page)) : cur.zoom;
		let zoom = base;
		if (rect.h * zoom > this.vh * 0.8) zoom = (this.vh * 0.8) / rect.h;
		if (rect.w * zoom > this.vw - 2 * m) zoom = Math.min(zoom, (this.vw - 2 * m) / rect.w);
		zoom = this.clampZoom(zoom);
		const fit = zoom === base ? this.fitMode : false;
		const viewW = this.vw / zoom;
		// Keep the horizontal centre when zooming; recentre only if the rect is cut off.
		let x = zoom === cur.zoom ? cur.x : cur.x + this.vw / 2 / cur.zoom - viewW / 2;
		const mx = m / zoom;
		if (dx0 < x + mx || dx0 + rect.w > x + viewW - mx) x = dx0 + rect.w / 2 - viewW / 2;
		const hpx = rect.h * zoom;
		let top = align === "center" ? (this.vh - hpx) / 2 : align === "start" ? m : this.vh * (typeof align === "number" ? align : 0.3);
		top = Math.max(m, Math.min(top, this.vh - hpx - m)) + offset;
		return { cam: this.clampCam({ x, y: dy0 - top / zoom, zoom }), fit };
	}

	/** `offset`: css px between the viewport top and the target (default: `pageGap` px). */
	private gotoTarget(page: number, top = 0, offset?: number): { cam: Camera; fit: Fit } | null {
		const r = this.layout[page];
		if (!r) return null;
		// Never let a bad destination (NaN from a broken link) reach the camera.
		if (!Number.isFinite(top)) top = 0;
		if (offset !== undefined && !Number.isFinite(offset)) offset = undefined;
		// Fit-page fits the destination page, whatever the size of the one in view.
		const z = this.fitMode === "page" ? this.clampZoom(this.fitZoom("page", page)) : this.cam.zoom;
		if (this.fitMode === "page" && !top && offset === undefined) return { cam: this.clampCam(this.fitPageCam(page, z)), fit: "page" };
		const x = z === this.cam.zoom ? this.cam.x : this.cam.x + this.vw / 2 / this.cam.zoom - this.vw / 2 / z;
		return { cam: this.clampCam({ x, y: r.y + top - (offset ?? this.opts.pageGap) / z, zoom: z }), fit: this.fitMode };
	}

	/** Move the camera to the target, animated unless asked otherwise or reduced motion is on. */
	private fly(id: number, animate: boolean, retarget: Flight["retarget"]) {
		this.cancelFlight("jump");
		this.velocity = { x: 0, y: 0 };
		if (!this.canAim()) {
			this.pending = { id, requested: performance.now(), retarget };
			return;
		}
		const target = retarget();
		if (!target) {
			if (id) this.emit({ type: "flight", id, landed: false, cause: "no-target", coverage: 0, waitMs: 0, durationMs: 0 });
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
			this.land(id, target, 0);
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

	/** Put the camera on `target` now. */
	private land(id: number, target: { cam: Camera; fit: Fit }, waitMs: number) {
		this.pendingFraction = null;
		const zoomed = target.cam.zoom !== this.cam.zoom;
		this.cam = { ...target.cam };
		this.fitMode = target.fit;
		if (zoomed) this.zoomChanged();
		this.sharpWait = { cause: "jump", since: performance.now() };
		this.requestFrame();
		if (id) this.emit({ type: "flight", id, landed: true, coverage: this.coverage(this.pagesIn(this.viewRect())), waitMs, durationMs: 0 });
	}

	/** Lands instantly: the reader never saw where a waiting jump started. */
	private landPending() {
		const p = this.pending;
		if (!p || !this.canAim()) return;
		this.pending = null;
		const target = p.retarget();
		if (target) this.land(p.id, target, performance.now() - p.requested);
		else if (p.id) this.emit({ type: "flight", id: p.id, landed: false, cause: "no-target", coverage: 0, waitMs: 0, durationMs: 0 });
	}

	/** The view lost its size mid-flight: finish the move unseen and re-aim once it is back. */
	private parkFlight() {
		const f = this.flight;
		if (!f) return;
		this.flight = null;
		this.pinned.clear();
		const zoomed = f.to.zoom !== this.cam.zoom;
		this.cam = { ...f.to };
		this.fitMode = f.fit;
		if (zoomed) this.zoomChanged();
		this.pending = { id: f.id, requested: f.requested, retarget: f.retarget };
	}

	/** Stop a flight where it is (user input or another jump); a waiting jump is dropped. */
	private cancelFlight(cause: FlightCause) {
		this.pendingFraction = null;
		const p = this.pending;
		if (p) {
			this.pending = null;
			if (p.id) this.emit({ type: "flight", id: p.id, landed: false, cause, coverage: 0, waitMs: 0, durationMs: 0 });
		}
		const f = this.flight;
		if (!f) return;
		this.flight = null;
		this.pinned.clear();
		if (this.cam.zoom !== f.from.zoom) {
			this.fitMode = false;
			this.zoomChanged();
		}
		if (f.id) this.emit({ type: "flight", id: f.id, landed: false, cause, coverage: 0, waitMs: 0, durationMs: 0 });
		this.requestFrame();
	}

	/** Advance the flight for this frame; true while it is still going. */
	private stepFlight(now: number) {
		const f = this.flight;
		if (!f) return false;
		if (f.start < 0) {
			const ready = f.pages.every((p) => this.hasPageBitmap(p));
			if (!ready && performance.now() - f.requested < FLIGHT_WAIT_MS) return true;
			f.start = now;
		}
		const t = Math.min(1, (now - f.start) / f.dur);
		if (t >= 1) {
			this.cam = { ...f.to };
			this.fitMode = f.fit;
			this.flight = null;
			this.pinned.clear();
			this.sharpWait = { cause: "jump", since: performance.now() };
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
		this.sharpWait = { cause: "zoom", since: this.lastZoomChange };
		if (this.settleTimer) clearTimeout(this.settleTimer);
		if (this.disposed) return;
		this.settleTimer = setTimeout(() => this.requestFrame(), ZOOM_SETTLE_MS + 10);
		this.requestFrame();
	}

	private panBy(dx: number, dy: number) {
		this.pendingFraction = null;
		this.cam.x += dx / this.cam.zoom;
		this.cam.y += dy / this.cam.zoom;
		this.clampCamera();
		this.requestFrame();
	}

	// ---------------------------------------------------------------- input

	handle(msg: InputMsg) {
		if (this.disposed) return;
		switch (msg.type) {
			case "resize": {
				const changed = msg.w !== this.vw || msg.h !== this.vh || msg.dpr !== this.dpr;
				// Keep the doc point at the top-centre of the view fixed.
				const anchorX = this.cam.x + this.measuredW / 2 / this.cam.zoom;
				const anchorY = this.cam.y;
				this.vw = msg.w;
				this.vh = msg.h;
				this.dpr = msg.dpr;
				this.gl.resize(Math.round(msg.w * msg.dpr), Math.round(msg.h * msg.dpr));
				const wasReady = this.camReady;
				this.initCamera();
				// A hidden view keeps its camera for the last size it had.
				if (!this.canAim()) this.parkFlight();
				else if (changed && wasReady) {
					if (this.fitMode) {
						const z = this.clampZoom(this.fitZoom(this.fitMode));
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
				if (this.vw > 0 && this.vh > 0) this.measuredW = this.vw;
				this.landPending();
				// Resizing clears the drawing buffer: draw synchronously so the
				// new size never shows an empty frame.
				this.dirty = true;
				this.frame(performance.now());
				this.emit({ type: "resized", w: msg.w, h: msg.h });
				return;
			}
			case "wheel": {
				this.cancelFlight("input");
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
				this.cancelFlight("input");
				if (msg.phase === "start") this.gestureZoom = this.cam.zoom;
				else if (msg.phase === "change" && this.gestureZoom !== null) this.userZoom(this.gestureZoom * msg.scale, msg.x, msg.y);
				else this.gestureZoom = null;
				return;
			}
			case "pointer":
				if (msg.phase === "down") this.cancelFlight("input");
				if (msg.kind === "touch") this.touch(msg);
				else this.mouse(msg);
				return;
			case "key":
				this.cancelFlight("input");
				this.key(msg);
				return;
			case "leave":
				this.setCursor("default");
				this.setHovered(null);
				return;
		}
	}

	private touch(msg: Extract<InputMsg, { type: "pointer" }>) {
		// iOS Safari can drop the pointerup of a fast pinch; a primary down proves no other finger is still on the screen.
		if (msg.phase === "down" && msg.primary) this.touches.clear();
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
		if (at && !text) {
			// Text still loading: select once it arrives, if the finger is still down.
			press.waitingText = at.page;
			this.requestText(at.page, 0);
			return;
		}
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
		this.selGen++;
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
			this.selGen++;
			this.downAt = { x: msg.x, y: msg.y };
			this.pendingPress = null;
			const hit = this.hitPoint(msg.x, msg.y);
			if (!hit) {
				const at = this.toPage(msg.x, msg.y);
				if (!at || !this.textPending.has(at.page)) {
					this.clearSelection();
					return;
				}
				// The page's text is on its way (raised to the front by hitPoint): keep the gesture.
				this.dragging = true;
				this.handles = false;
				// no anchor until the text arrives, so moves meanwhile cannot change the range
				this.selAnchor = null;
				if (!msg.shift) this.setRange(null);
				this.pendingPress = { page: at.page, ...this.toDoc(msg.x, msg.y), clicks: msg.clicks, shift: msg.shift, gen: this.selGen, release: null };
				this.emit({ type: "selection", selection: null, final: false });
				return;
			}
			this.startSelection(hit, msg.shift, msg.clicks);
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
			const waiting = this.pendingPress;
			if (waiting) {
				this.dragging = false;
				if ((click && !waiting.shift) || msg.phase === "cancel") {
					this.pendingPress = null;
					this.emitSelection(true);
					if (click && !this.selRange) this.click(msg.x, msg.y);
				} else waiting.release = this.toDoc(msg.x, msg.y);
				return;
			}
			if (this.dragging) {
				this.dragging = false;
				this.emitSelection(true);
			}
			if (click && !this.selRange) this.click(msg.x, msg.y);
		}
	}

	private startSelection(hit: TextPoint, shift: boolean, clicks: number) {
		this.dragging = true;
		this.handles = false;
		this.emit({ type: "selection", selection: null, final: false });
		if (shift && this.selRange) {
			this.selUnit = "char";
			this.selAnchor = [this.selRange[0], this.selRange[0]];
			this.setFocus(hit);
			return;
		}
		this.selUnit = clicks >= 3 ? "line" : clicks === 2 ? "word" : "char";
		this.selAnchor = this.expand(hit);
		if (this.selUnit === "char") this.setRange(null);
		else this.setFocus(hit);
	}

	/** A press that waited for this page's text starts its selection where it was made. */
	private resolvePress(page: number) {
		const p = this.pendingPress;
		if (!p || p.page !== page) return;
		this.pendingPress = null;
		if (p.gen !== this.selGen) return;
		if (!p.anchored) {
			const anchor = this.hitDoc(p.x, p.y);
			if (!anchor) return;
			const dragging = this.dragging;
			this.startSelection(anchor, p.shift, p.clicks);
			if (dragging) {
				this.updateDrag();
				return;
			}
			this.dragging = false;
		}
		const release = p.release;
		const focusPage = release ? this.pageAtDocY(release.y) : -1;
		if (release && !this.texts.has(focusPage)) {
			this.pendingPress = { ...p, page: focusPage, anchored: true, gen: this.selGen };
			this.requestText(focusPage, 0);
			return;
		}
		const focus = release && this.hitDoc(release.x, release.y);
		if (focus) this.setFocus(focus);
		this.emitSelection(true);
		this.requestFrame();
	}

	private toDoc(sx: number, sy: number) {
		return { x: this.cam.x + sx / this.cam.zoom, y: this.cam.y + sy / this.cam.zoom };
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
		else if (msg.mod && msg.key === "0") this.command({ type: this.fitMode === "page" ? "fit-page" : "fit-width" });
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
		const gen = ++this.selGen;
		const view = this.viewRect();
		const page = this.pageAtDocY((view.y0 + view.y1) / 2);
		const current = await this.loadText(page);
		if (gen !== this.selGen) return;
		const pageSelected =
			this.selRange && comparePoints(this.selRange[0], { page, index: 0 }) <= 0 && comparePoints(this.selRange[1], { page, index: current.length }) >= 0;
		if (scope === "page" || (scope === "auto" && !pageSelected)) {
			this.handles = false;
			this.selectRange(page, 0, current.length);
			return;
		}
		const last = this.pages.length - 1;
		const texts = await Promise.all(this.pages.map((_, i) => this.loadText(i)));
		if (gen !== this.selGen) return;
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
		if (this.disposed) return;
		switch (cmd.type) {
			case "zoom":
				if (!Number.isFinite(cmd.zoom)) return;
				this.cancelFlight("command");
				this.userZoom(cmd.zoom, cmd.x ?? this.vw / 2, cmd.y ?? this.vh / 2);
				return;
			case "fit-width":
				this.cancelFlight("command");
				this.zoomAt(this.fitZoom("width"), this.vw / 2, 0);
				this.fitMode = "width";
				this.requestFrame();
				return;
			case "fit-page": {
				this.cancelFlight("command");
				const page = this.currentPage();
				const zoom = this.clampZoom(this.fitZoom("page", page));
				const zoomed = zoom !== this.cam.zoom;
				this.cam = this.clampCam(this.fitPageCam(page, zoom));
				this.fitMode = "page";
				if (zoomed) this.zoomChanged();
				this.requestFrame();
				return;
			}
			case "remote":
				if (cmd.on) this.pool.affinity = true;
				else this.pool.releaseAffinity();
				return;
			case "scroll-to": {
				if (!Number.isFinite(cmd.fraction)) return;
				this.cancelFlight("command");
				const viewH = this.vh / this.cam.zoom;
				const fraction = Math.max(0, Math.min(1, cmd.fraction));
				this.cam.y = fraction * Math.max(0, this.docH - viewH);
				this.clampCamera();
				// Exact only once every size is known: the target is re-solved as they arrive (pages around it first).
				if (this.unknown > 0) {
					this.pendingFraction = fraction;
					this.backgroundSizes(Math.floor(fraction * (this.pages.length - 1)), 100);
				}
				this.requestFrame();
				return;
			}
			case "goto": {
				const { page, top, offset } = cmd;
				this.fly(cmd.flight ?? 0, cmd.animate ?? false, () => this.gotoTarget(page, top, offset));
				return;
			}
			case "reveal": {
				const { page, rect, align, ifNeeded, offset } = cmd;
				let first = true;
				// ifNeeded only applies to the first aim; a resize re-aims for real.
				this.fly(cmd.flight ?? 0, cmd.animate ?? false, () => {
					const t = this.revealTarget(page, rect, align, first && ifNeeded, offset);
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
				if (!Number.isFinite(cmd.dx) || !Number.isFinite(cmd.dy)) return;
				this.cancelFlight("command");
				this.panBy(cmd.dx, cmd.dy);
				return;
			case "select-all":
				void this.selectAll(cmd.scope ?? "auto");
				return;
			case "tile-cache": {
				if (this.cache) return;
				const cache = new TileCache(cmd.key, cmd.budgetMB * 1024 * 1024, this.opts.textureBudgetMB <= 128 ? 2 : 4);
				this.cache = cache;
				// tiles planned while it opened go to the cache now; bitmaps queued meanwhile get written
				void cache.ready.then(() => {
					if (!this.disposed && cache.enabled) this.requestFrame();
				});
				return;
			}
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
	private thumbs = new Map<string, Promise<{ buf: ArrayBuffer; w: number; h: number } | null>>();

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
				const s0 = Math.max(0, from - 40);
				const before = text.text(s0, from);
				let snippet = before + text.text(from, Math.min(text.length, to + 40));
				let matchEnd = before.length + text.text(from, to).length;
				const tail = m.end - pageLen - sep;
				if (next && tail > 0) {
					const nFrom = next.map[0]!;
					const nTo = next.map[tail - 1]! + 1;
					parts.push({ page: nextPage, index: nFrom, length: nTo - nFrom, rects: next.text.rects(nFrom, nTo) });
					const head = `${before}${text.text(from, text.length)}`.trimEnd();
					snippet = `${head} ${next.text.text(nFrom, Math.min(next.text.length, nTo + 40))}`;
					matchEnd = head.length + 1 + next.text.text(nFrom, nTo).length;
				}
				const first = parts[0]!;
				return {
					page,
					index: first.index,
					length: first.length,
					snippet,
					snippetMatch: [before.length, matchEnd],
					rects: first.rects,
					score: m.score,
					exact: m.score === 1,
					parts,
				};
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
				if (this.estimated[req.page]) await this.knownSize(req.page);
				const size = this.pages[req.page];
				if (!size) throw new Error(`no page ${req.page}`);
				const scale = req.width / size.w;
				const w = Math.max(1, Math.round(size.w * scale));
				const h = Math.max(1, Math.round(size.h * scale));
				// Concurrent requests for one thumbnail share a job (the pool keeps one
				// callback per key). Callers only read the pixels.
				const key = `thumb:${req.page}:${w}`;
				let job = this.thumbs.get(key);
				if (!job) {
					job = new Promise((resolve) => {
						this.pool.request(key, 600 + req.page, { t: "tile", page: req.page, scale, x: 0, y: 0, w, h }, (res) => {
							this.thumbs.delete(key);
							resolve(res.t === "tile" ? { buf: res.buf, w: res.w, h: res.h } : null);
						});
						this.pool.pump();
					});
					this.thumbs.set(key, job);
				}
				return job;
			}
			case "outline":
				this.outline ??= new Promise((resolve) => {
					this.pool.request("outline", 400, { t: "outline", page: -1 }, (res) => resolve(res.t === "outline" ? res.items : []));
					this.pool.pump();
				});
				return this.outline;
			case "search": {
				const fuzzy = !!req.fuzzy;
				const r = await this.runSearch(id, req.query, { ...req, limit: req.limit ?? 500, threshold: req.fuzzy?.threshold ?? (fuzzy ? 0.7 : 1) }, fuzzy, null).finally(() =>
					this.cancelled.delete(id),
				);
				return [...r.exactMatches, ...r.fuzzyMatches];
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
		const { x, y } = this.toDoc(sx, sy);
		return this.hitDoc(x, y);
	}

	private hitDoc(dx: number, dy: number): TextPoint | null {
		if (this.layout.length === 0) return null;
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
		const gen = ++this.selGen;
		const texts = await Promise.all(Array.from({ length: e0 - s0 + 1 }, (_, i) => this.loadText(s0 + i)));
		if (gen !== this.selGen) return;
		const clamp = (p: number, i: number) => Math.max(0, Math.min(texts[p - s0]!.length, i));
		const start = { page: s0, index: clamp(s0, s.index) };
		const end = { page: e0, index: clamp(e0, e.index) };
		this.handles = false;
		this.selAnchor = [start, start];
		// Recompute rects even if the range is unchanged (text may have loaded since).
		this.setRange(comparePoints(start, end) === 0 ? null : [start, end], true);
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

	/** `force`: rebuild the rects even when the range is unchanged. */
	private setRange(range: [TextPoint, TextPoint] | null, force = false) {
		this.selGen++;
		const same =
			range && this.selRange && comparePoints(range[0], this.selRange[0]) === 0 && comparePoints(range[1], this.selRange[1]) === 0;
		if (!force && (same || (!range && !this.selRange))) return;
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
		this.selGen++;
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
		if (this.texts.has(page)) return;
		const queued = this.textPending.get(page);
		if (queued !== undefined && queued <= priority) return;
		this.textPending.set(page, priority);
		if (queued !== undefined) {
			// already requested: only raise its priority (a press is waiting on it)
			this.pool.request(`text:${page}`, priority, { t: "text", page }, () => {});
			this.pool.pump();
			return;
		}
		this.pool.request(`text:${page}`, priority, { t: "text", page }, (res) => {
			this.textPending.delete(page);
			if (res.t !== "text") {
				// Extraction failed: the page has no text, and waiters (search) move on.
				if (res.t === "error") {
					this.texts.set(page, new PageText(new Uint32Array(0), new Float32Array(0)));
					for (const fn of this.textWaiters.get(page) ?? []) fn();
					this.textWaiters.delete(page);
					this.textArrived(page);
				}
				return;
			}
			const r = res as TextResult;
			if (this.estimated[page]) this.applySizes([[page, r.size.w, r.size.h]]);
			this.texts.set(page, new PageText(r.codes, r.boxes));
			this.links.set(page, r.links);
			if (r.images.length) {
				this.images.set(page, r.images);
				if (this.opts.dark) this.requestFrame();
			}
			for (const fn of this.textWaiters.get(page) ?? []) fn();
			this.textWaiters.delete(page);
			this.textArrived(page);
		});
		this.pool.pump();
	}

	private textArrived(page: number) {
		if (this.press?.waitingText === page && this.press.timer === null && this.touches.size === 1) {
			this.press.waitingText = undefined;
			this.longPress();
			return;
		}
		if (this.pendingPress?.page === page) {
			this.resolvePress(page);
			return;
		}
		if (this.dragging) this.updateDrag();
		else this.updateCursor(this.pointer.x, this.pointer.y);
	}

	// ---------------------------------------------------------------- tiles

	private baseScale(page: number) {
		const p = this.pages[page]!;
		return 2 ** Math.floor(Math.log2(BASE_MAX / Math.max(p.w, p.h)));
	}

	/** a whole-page bitmap (base or its preview) is on the GPU */
	private hasPageBitmap(page: number) {
		const s = this.baseScale(page);
		return !!(this.tiles.get(this.tileKey(page, s, 0, 0))?.tex || this.tiles.get(this.tileKey(page, s / PREVIEW_DIV, 0, 0))?.tex);
	}

	private tileKey(page: number, scale: number, x: number, y: number) {
		return `${page}:${scale}:${x}:${y}`;
	}

	private ensureTile(page: number, scale: number, x: number, y: number, w: number, h: number, priority: number, keep: Set<string>, pin = false) {
		const key = this.tileKey(page, scale, x, y);
		if (pin) this.pinned.add(key);
		const existing = this.tiles.get(key);
		if (existing) existing.lastWanted = this.frameId;
		if (existing && (existing.tex || existing.arrived || existing.failed || existing.loading)) return;
		let tile = existing;
		if (!tile) {
			tile = { key, page, scale, x, y, w, h, tex: null, arrived: false, lastUsed: 0, lastWanted: this.frameId };
			this.tiles.set(key, tile);
			let set = this.tilesByPage.get(page);
			if (!set) this.tilesByPage.set(page, (set = new Set()));
			set.add(tile);
		}
		// Not kept for the pool while it loads from the cache: a queued raster job for it is dropped.
		if (scale === this.baseScale(page) && this.cache?.has(page, scale, w, h)) {
			this.loadCached(tile);
			return;
		}
		keep.add(key);
		this.requestTile(tile, priority);
	}

	private loadCached(tile: Tile) {
		tile.loading = true;
		void this.cache!.get(tile.page, tile.scale, tile.w, tile.h).then((bitmap) => {
			tile.loading = false;
			if (this.disposed || this.tiles.get(tile.key) !== tile || tile.tex || tile.arrived || !bitmap || bitmap.width !== tile.w || bitmap.height !== tile.h) {
				bitmap?.close();
				// a miss renders it as usual on the next plan
				this.requestFrame();
				return;
			}
			this.firstTileAt ||= epochNow();
			this.cacheHits++;
			tile.arrived = true;
			this.arrived.push({ tile, pixels: bitmap });
			this.requestFrame();
		});
	}

	private requestTile(tile: Tile, priority: number) {
		const { key, page, scale, x, y, w, h } = tile;
		const asked = performance.now();
		const size = this.pages[page]!;
		const frac = (w * h) / Math.max(1, Math.round(size.w * scale) * Math.round(size.h * scale));
		this.pool.request(key, priority, { t: "tile", page, scale, x, y, w, h }, (res) => {
			if (res.t === "error") tile.failed = true;
			if (res.t !== "tile") return;
			const r = res as TileResult;
			this.tileMs.push(r.ms);
			this.firstTileAt ||= epochNow();
			if (this.tileLog.length < 5000) this.tileLog.push({ page, base: scale <= this.baseScale(page), ms: r.ms, waitMs: performance.now() - asked });
			const pixels = new Uint8Array(r.buf);
			// Slow pages are worth keeping for the next open; cheap ones render faster than they decode.
			if (this.cache && r.ms >= CACHE_MIN_MS && scale === this.baseScale(page)) this.cache.put(page, scale, pixels, w, h);
			if (this.tiles.get(key) !== tile || tile.tex || tile.arrived) return;
			tile.arrived = true;
			this.arrived.push({ tile, pixels });
			this.requestFrame();
		}, Math.min(1, frac));
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
		// Pages whose size is still an estimate get their size first, and no tiles until then.
		this.requestSizes(near, -2);
		this.backgroundSizes(visible[0] ?? 0);
		const shown = new Set(targetVisible);
		const baseTile = (p: number, priority: number, pin = false) => {
			if (this.estimated[p]) return;
			const s = this.baseScale(p);
			const size = this.pages[p]!;
			const w = Math.round(size.w * s);
			const h = Math.round(size.h * s);
			if (keep.has(this.tileKey(p, s, 0, 0))) return;
			// A heavy page about to be blank shows a coarse pass while its base renders; scans gain nothing (decode-bound).
			const base = this.tiles.get(this.tileKey(p, s, 0, 0));
			if ((pin || shown.has(p)) && !base?.tex && !base?.arrived && !base?.loading) {
				const cost = this.pool.predict(p);
				const ps = s / PREVIEW_DIV;
				if (cost.ms > PREVIEW_MS && cost.overhead < cost.ms * 0.3) this.ensureTile(p, ps, 0, 0, Math.max(1, Math.round(size.w * ps)), Math.max(1, Math.round(size.h * ps)), priority - 0.5, keep, pin);
			}
			this.ensureTile(p, s, 0, 0, w, h, priority, keep, pin);
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

		// 1. a whole-page base bitmap for everything near the viewport: never blank.
		// Pages past the look-ahead come after the visible sharp tiles.
		const first = Math.max(0, (near[0] ?? 0) - 3);
		const last = Math.min(this.layout.length - 1, (near[near.length - 1] ?? 0) + 3);
		const nearSet = new Set(near);
		for (let p = first; p <= last; p++) baseTile(p, (nearSet.has(p) ? 0 : 25) + Math.abs(this.layout[p]!.y + this.layout[p]!.h / 2 - cy) / 1e6);

		// 2. sharp tiles: visible first (by distance from centre), then look-ahead.
		// In flight, what passes by mid-way comes after the destination.
		const passing = flight && flight.to.zoom === this.cam.zoom ? ([visible, this.viewRect(), 20] as const) : null;
		for (const [pages, region, base] of [[targetVisible, view, 10] as const, ...(passing ? [passing] : []), [near, ahead, 30] as const]) {
			for (const p of pages) {
				if (base === 10) this.requestText(p, 20);
				if (this.estimated[p]) continue;
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
						// A later pass must not demote a tile an earlier one asked for (the pool keeps the last priority).
						if (base !== 10 && keep.has(this.tileKey(p, s, x, y))) continue;
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
			if (!tile.tex && !tile.arrived && !tile.failed && !tile.loading && !keep.has(tile.key) && !this.pool.has(tile.key)) this.dropTile(tile);
		}
		return visible;
	}

	private dropTile(tile: Tile) {
		this.tiles.delete(tile.key);
		this.tilesByPage.get(tile.page)?.delete(tile);
		if (tile.tex) this.gl.free(tile.tex, tile.w, tile.h);
	}


	/** Uploads arrived tiles, most visible first, within a byte budget so one frame never carries a burst. */
	private uploadArrived(visible: number[]) {
		const t0 = performance.now();
		let bytes = 0;
		// Off-screen pixels nothing plans any more are dropped; on-screen ones still serve as fallbacks (old zoom levels).
		const stale = (tile: Tile) => tile.lastWanted !== this.frameId && (!visible.includes(tile.page) || tile.scale === this.targetScale);
		if (this.arrived.some((a) => stale(a.tile))) {
			this.arrived = this.arrived.filter(({ tile, pixels }) => {
				if (!stale(tile)) return true;
				if (!(pixels instanceof Uint8Array)) pixels.close();
				tile.arrived = false;
				if (this.tiles.get(tile.key) === tile && !tile.tex) this.dropTile(tile);
				return false;
			});
		}
		if (this.arrived.length > 1) {
			const rank = (t: Tile) => uploadRank(t, visible, this.frameId, this.baseScale(t.page), this.targetScale);
			this.arrived.sort((a, b) => rank(a.tile) - rank(b.tile));
		}
		while (this.arrived.length > 0 && performance.now() - t0 < UPLOAD_BUDGET_MS) {
			const next = this.arrived[0]!;
			if (bytes > 0 && bytes + next.tile.w * next.tile.h * 4 > this.uploadBudget) break;
			this.arrived.shift();
			const { tile, pixels } = next;
			tile.arrived = false;
			if (this.tiles.get(tile.key) !== tile || tile.tex) {
				if (!(pixels instanceof Uint8Array)) pixels.close();
				continue;
			}
			tile.tex = this.gl.upload(pixels, tile.w, tile.h);
			if (!(pixels instanceof Uint8Array)) pixels.close();
			// Lost mid-frame: fetch it again after the restore.
			if (!tile.tex) break;
			bytes += tile.w * tile.h * 4;
		}
		this.uploadedLast = bytes;
		if (bytes > this.uploadPeak) this.uploadPeak = bytes;
	}

	/**
	 * Over the texture budget, drop least recently drawn tiles back to 85% of
	 * it, a few MB per frame: freeing a whole batch at once is a GPU burst. Over
	 * the hard budget everything needed goes at once.
	 */
	private evict(frameId: number) {
		const budget = this.opts.textureBudgetMB * 1024 * 1024;
		if (this.gl.textureBytes <= budget) {
			if (this.evicting === 0) return;
		} else if (this.evicting === 0) this.evicting = budget * 0.85;
		const floor = Math.max(this.evicting, this.gl.textureBytes - EVICT_STEP);
		// Tiles this frame drew or planned (look-ahead) stay: evicting a planned
		// tile only makes the next plan request it again.
		while (this.gl.textureBytes > floor || this.gl.textureBytes > budget) {
			const t = this.oldestTile(frameId, false);
			if (!t) break;
			this.dropTile(t);
		}
		if (this.gl.textureBytes <= this.evicting) this.evicting = 0;
		// Still over: give up look-ahead tiles too (never what is on screen, nor a
		// flight's destination).
		while (this.gl.textureBytes > budget) {
			const t = this.oldestTile(frameId, true);
			if (!t) break;
			this.dropTile(t);
		}
	}

	private evicting = 0;

	private oldestTile(frameId: number, ahead: boolean) {
		let oldest: Tile | null = null;
		for (const t of this.tiles.values()) {
			if (!t.tex || t.lastUsed === frameId || (ahead ? this.pinned.has(t.key) : t.lastWanted === frameId)) continue;
			if (!oldest || t.lastUsed < oldest.lastUsed) oldest = t;
		}
		return oldest;
	}

	// ---------------------------------------------------------------- frame

	requestFrame() {
		this.dirty = true;
		if (this.scheduled || this.disposed) return;
		this.scheduled = true;
		const t = performance.now();
		// Input queued behind a long frame is handled the moment it ends: that frame is late, not idle.
		this.wantedAt = this.inFrame || t - this.frameEnd < 2 ? this.lastFrame : t;
		this.raf((t) => {
			this.scheduled = false;
			if (!this.disposed) this.frame(t);
		});
	}

	private frameId = 0;
	private painted = false;

	private frame(now: number) {
		// A lost context draws nothing; `contextRestored` asks for a frame.
		if (!this.dirty || !this.canAim() || this.disposed || this.gl.lost) return;
		const cpu0 = performance.now();
		const dt = this.lastFrame ? Math.min(64, now - this.lastFrame) : 16;
		if (this.lastFrame) this.recordFrame(now);
		this.lastFrame = now;
		this.dirty = false;
		this.frameId++;
		this.inFrame = true;

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
		this.uploadArrived(visible);
		const sharp = this.draw(visible, now);
		if (this.marksAnimating(now)) moving = true;
		this.evict(this.frameId);
		this.reportSharp(sharp);

		this.cpuTimes.push(performance.now() - cpu0);
		this.reportView(visible);
		this.reportStats(now);

		this.animating = moving || this.arrived.length > 0 || this.dirty;
		if (this.cache?.queued) this.cacheWhenIdle();
		if (this.animating) this.requestFrame();
		this.inFrame = false;
		this.frameEnd = performance.now();
	}

	private recordFrame(now: number) {
		const continuous = this.wantedAt === this.lastFrame;
		const ms = now - (continuous ? this.lastFrame : Math.min(now, this.wantedAt));
		if (ms > SUSPENDED_MS) return;
		if (continuous) {
			this.frameTimes.push(ms);
			const late = ms > this.vsync * 1.5;
			// Late frames without uploads are the display's cadence (30Hz, throttled tab), so they still move the estimate.
			if (!late || this.uploadedLast === 0) this.vsync += (ms - this.vsync) * 0.05;
			if (!late) this.uploadBudget = Math.min(UPLOAD_MAX, this.uploadBudget + UPLOAD_MIN);
			else if (this.uploadedLast > 0) this.uploadBudget = Math.max(UPLOAD_MIN, this.uploadBudget / 2);
		}
		this.windowFrames++;
		if (ms > this.worstFrame) this.worstFrame = ms;
		if (ms > 33) this.over33++;
		if (ms > 50) this.over50++;
		if (ms > 100) this.over100++;
	}

	private reportSharp(sharp: boolean) {
		const wait = this.sharpWait;
		if (!wait || this.flight) return;
		const t = performance.now();
		if (t - wait.since > 15000) this.sharpWait = null;
		else if (sharp && t - this.lastZoomChange >= ZOOM_SETTLE_MS) {
			this.sharpWait = null;
			this.emit({ type: "sharp", cause: wait.cause, ms: t - wait.since });
		}
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

	/** Returns whether every visible page is drawn at the target scale. */
	private draw(visible: number[], now: number) {
		let sharp = true;
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
		const mark = (c: Color, dark: boolean): Color => markColor(c, dark ? paper : null);
		const px = this.dpr;
		gl.resetState();
		gl.begin(background);
		const view = this.viewRect();
		for (const p of visible) {
			const r = this.layout[p]!;
			const sx = (r.x - this.cam.x) * S;
			const sy = (r.y - this.cam.y) * S;
			const pw = r.w * S;
			const ph = r.h * S;
			// The 1px page edge as four strips: a blended quad under the whole page costs a full-page blend on fill-bound GPUs.
			gl.drawRect(sx - 1, sy - 1, pw + 2, 1, PAGE_EDGE, "alpha");
			gl.drawRect(sx - 1, sy + ph, pw + 2, 1, PAGE_EDGE, "alpha");
			gl.drawRect(sx - 1, sy, 1, ph, PAGE_EDGE, "alpha");
			gl.drawRect(sx + pw, sy, 1, ph, PAGE_EDGE, "alpha");
			gl.drawRect(sx, sy, pw, ph, dark ? [paper[0], paper[1], paper[2], 1] : WHITE);

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
			const covered = this.coveredByTarget(p, ready, target);
			const start = covered ? ready.findIndex((t) => t.scale === target) : 0;
			const base = this.baseScale(p);
			if (!covered && !(target <= base && ready.some((t) => t.scale === base))) sharp = false;
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
					if (!this.painted) {
						this.painted = true;
						this.emit({ type: "painted", page: p, timing: { firstTileAt: this.firstTileAt || epochNow(), paintedAt: epochNow(), cacheHits: this.cacheHits } });
					}
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
		return sharp;
	}

	/**
	 * Benches only: tile jobs finished since the last call, and how much of the
	 * visible page area shows any bitmap (`drawn`) or a target-scale one (`sharp`).
	 */
	debugProbe() {
		const view = this.viewRect();
		let area = 0;
		let drawn = 0;
		for (const p of this.pagesIn(view)) {
			const r = this.layout[p]!;
			const a = Math.max(0, Math.min(view.x1, r.x + r.w) - Math.max(view.x0, r.x)) * Math.max(0, Math.min(view.y1, r.y + r.h) - Math.max(view.y0, r.y));
			area += a;
			if (this.hasPageBitmap(p)) drawn += a;
			else drawn += a * this.coverage([p]);
		}
		const log = this.tileLog;
		this.tileLog = [];
		return { drawn: area ? drawn / area : 1, sharp: this.coverage(this.pagesIn(view)), pending: this.pool.pending, textureMB: this.gl.textureBytes / 1048576, workerMB: this.pool.heapBytes / 1048576, log };
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
	private cacheTimer: ReturnType<typeof setTimeout> | null = null;

	/** Encodes queued cache bitmaps one at a time once the view has rested and the workers are idle. */
	private cacheWhenIdle() {
		if (this.cacheTimer || this.disposed) return;
		this.cacheTimer = setTimeout(() => {
			this.cacheTimer = null;
			const cache = this.cache;
			if (!cache?.queued || this.disposed) return;
			if (this.animating || this.pool.pending > 0 || performance.now() - this.lastFrame < CACHE_IDLE_MS) {
				this.cacheWhenIdle();
				return;
			}
			void cache.writeNext().then(() => {
				if (cache.queued) this.cacheWhenIdle();
			});
		}, CACHE_IDLE_MS);
	}

	/** Emits `moving: false` once the camera has rested; hosts re-show tooltips then. */
	private cameraIdle() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.disposed) return;
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
		if (this.cache) this.cache.focus = page;
		this.emit({ type: "view", zoom: this.cam.zoom, page, pageCount: this.pages.length, fitWidth: this.fitMode === "width", fit: this.fitMode || null });
	}

	private reportStats(now: number) {
		if (now - this.lastStats < 500) return;
		this.lastStats = now;
		const ft = this.frameTimes.sort((a, b) => a - b);
		const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
		const total = this.frameTimes.reduce((a, b) => a + b, 0);
		this.emit({
			type: "stats",
			stats: {
				fps: total > 0 ? (this.frameTimes.length * 1000) / total : 0,
				p95FrameMs: ft[Math.floor(ft.length * 0.95)] ?? 0,
				worstFrameMs: this.worstFrame,
				frames: this.windowFrames,
				framesOver33: this.over33,
				framesOver50: this.over50,
				framesOver100: this.over100,
				uploadPeakBytes: this.uploadPeak,
				avgCpuMs: avg(this.cpuTimes),
				tiles: this.tiles.size,
				textureMB: this.gl.textureBytes / 1048576,
				pendingJobs: this.pool.pending,
				avgTileMs: avg(this.tileMs),
				targetScale: this.targetScale,
				workers: this.pool.workers,
				workerMB: this.pool.heapBytes / 1048576,
			},
		});
		this.frameTimes = [];
		this.cpuTimes = [];
		this.tileMs = [];
		this.windowFrames = this.worstFrame = this.over33 = this.over50 = this.over100 = this.uploadPeak = 0;
	}
}
