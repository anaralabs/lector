// Main-thread shell: owns the <canvas>, spawns workers, forwards input and
// mirrors the little state the DOM needs (cursor, copied text).

import {
	type Command,
	type CoreEvent,
	type Camera,
	type CoreOptions,
	defaultOptions,
	epochNow,
	type InputMsg,
	type LoadTimings,
	type PointerKind,
	type PulseKind,
	type Request,
	type RevealAlign,
	type SearchHit,
	type SearchResults,
	ViewerCore,
} from "./core";
import type { PdfAnnotation } from "./annotations";
import type { PageFigure } from "./figures";
import type { SearchOptions } from "./search";
import { EngineError } from "./errors";
import { FailedPages } from "./failed-pages";
import { FormLayer, modifiers, type FormHit } from "./form-layer";
import type { DocSource, DocumentInfo, OpenTiming, OutlineItem, PageSize, SizeHint, ToRaster } from "./protocol";
import { rasterWorkerCount } from "./raster-pool";
import { abandonWhole, HEAD_BYTES, rangesBeside, probeReadBytes, probeVerdict, RACE_FILE_MAX, RANGE_GRANULE, readLinearization, WHOLE_FILE_MAX } from "./range";
import { fetchRetrying, isNetworkError, retrying, retryableStatus } from "./retry";
import { findStartxref, pagePathObjects, parseXref } from "./xref";
import type { CompositorKind } from "./gl";
import { getEngineSupport } from "./support";
import { documentKey } from "./tile-cache";
import type { Rect, TextPoint } from "./text";
import { TextLayer, type TextLayerLine } from "./text-layer";
import { type CreateWorker, retryUrl, startWorker, type WorkerType } from "./worker-start";

export interface ViewerOptions extends Partial<CoreOptions> {
	/** URL of the package's `pdfium.wasm` (`@anaralabs/lector-engine/pdfium.wasm`) */
	wasmUrl: string;
	/** number of PDFium raster workers (default: half the cores, 2-4; 2 on touch devices or with 4GB or less; without a GPU 1, or 2 from 8 cores) */
	workers?: number;
	/** run the compositor in a worker with an OffscreenCanvas (default: when WebGL2 works on one) */
	offscreen?: boolean;
	onEvent?: (e: CoreEvent) => void;
	/**
	 * Creates the engine's workers. Override to wrap them (e.g. a blob loader
	 * that dynamic-imports `url`, which survives extensions that re-wrap module
	 * workers). `type` is "classic" in browsers without module workers: load
	 * `url` with `importScripts` there. A worker that fails to load is created
	 * again with a cache-busted `url`. The engine waits for each worker's `boot` message.
	 */
	createWorker?: CreateWorker;
	/**
	 * URLs of the bundled worker scripts (see `./vite`). Required with
	 * `createWorker` when assets live on another origin; otherwise the engine
	 * starts its workers with `new Worker(new URL(...))` for the bundler.
	 */
	workerUrls?: { raster: string; core: string };
	/** external link clicked; default opens it in a new tab */
	onLink?: (url: string) => void;
	/**
	 * URL sources: load with HTTP range requests, so the first page renders
	 * before the whole file has downloaded (default false). Needs a server that
	 * answers `Range` with 206 and no content encoding (and CORS exposing
	 * Content-Range for other origins); otherwise the engine falls back to a
	 * full download. The whole file still streams in the background after the
	 * first paint (see `autoFetch`).
	 */
	rangeLoading?: boolean;
	/** with `rangeLoading`: download the whole file after the first paint, then stop range requests (default true) */
	autoFetch?: boolean;
	/**
	 * Keep slow pages' base bitmaps in IndexedDB, so the document opens instantly
	 * next time (default false). `key` identifies the document (e.g. id plus
	 * version); without it, byte sources are keyed by a hash of their content and
	 * URL sources with range loading are not cached. Bitmaps of every document
	 * share `budgetMB` (default 64, 24 on touch devices), least recently used out
	 * first. Leave it off for documents that must not persist on the device.
	 */
	tileCache?: boolean | { key?: string; budgetMB?: number };
	/** password for an encrypted document (else an `error` event with code `password`; see `unlock`) */
	password?: string;
	/**
	 * Hidden DOM text for the visible pages ±1 (default true): screen readers
	 * read it and the browser's find (Cmd/Ctrl+F) matches it. It is transparent
	 * and click-through; selection stays on the GPU.
	 */
	textLayer?: boolean;
	/**
	 * Cmd/Ctrl+F while the viewer has focus emits a `find` event instead of
	 * opening the browser's find bar (default false). Native find only sees the
	 * pages near the viewport, so hosts with their own search UI should use this.
	 */
	interceptFind?: boolean;
}

export interface Viewer {
	readonly canvas: HTMLCanvasElement;
	readonly offscreen: boolean;
	/** what composites the pages: WebGL2, or Canvas 2D without a usable GPU */
	readonly compositor: CompositorKind;
	/**
	 * A div above the canvas (and the hidden text layer) for host overlays
	 * (popovers, page-anchored widgets). It is `pointer-events: none`: give
	 * interactive children `pointer-events: auto`. Keys typed into inputs or
	 * focusable elements here are left alone by the viewer.
	 */
	readonly overlayElement: HTMLDivElement;
	/**
	 * Resolves when the document has opened (like lector's `onDocumentLoad`):
	 * page sizes in points and metadata. Rejects if it cannot open; for a
	 * password-protected document it waits until `unlock` succeeds.
	 */
	readonly loaded: Promise<{ pages: PageSize[]; info: DocumentInfo }>;
	/** the resolved options: defaults, creation options and every `setOptions` since */
	readonly options: CoreOptions;
	zoomTo(zoom: number): void;
	fitWidth(): void;
	/** zoom so the page in view fits whole (sticky across resizes, like fit-width) */
	fitPage(): void;
	/**
	 * Resolves true once the camera lands, false if input or another jump
	 * interrupted it. Callable before `ready` or while hidden: it lands once
	 * the view has a size. `top`: page points below the page top; `offset`: css px
	 * kept between the viewport top and that point (default `pageGap`).
	 */
	goToPage(page: number, top?: number, options?: { animate?: boolean; offset?: number }): Promise<boolean>;
	/**
	 * The vertical scroll position as a scroll container would report it, in
	 * css px at the current zoom: for scroll persistence and custom scrollbars.
	 */
	scrollState(): { top: number; height: number; viewportHeight: number; fraction: number };
	/** scroll so the viewport top sits at `fraction` (0-1) of the scrollable range */
	scrollToFraction(fraction: number): void;
	/** the last camera (doc points at the viewport's top-left, zoom); pass it as `initialCamera` to restore exactly */
	readonly camera: Camera;
	/**
	 * Bring a page-space rect into view, e.g. a citation: its top lands at 30% of
	 * the viewport height (`align`), x only moves if it is cut off, and the zoom
	 * only drops if it is taller than 80% of the viewport. `animate` flies there
	 * (instant under prefers-reduced-motion); `ifNeeded` stays put when it is
	 * already fully visible. Resolves like `goToPage`.
	 */
	reveal(page: number, rect: Rect, options?: RevealOptions): Promise<boolean>;
	/** animate highlights by id: "ripple" (default, ~1s outward fade) or "flash" (whole-page blink) */
	pulse(ids: string | string[], options?: { kind?: PulseKind; duration?: number }): void;
	/** select chars [from, to) on a page (loads its text first if needed) */
	select(page: number, from: number, to: number): void;
	/** restore a selection across pages, e.g. a persisted `SelectionInfo.range`; null clears */
	setSelection(range: { start: TextPoint; end: TextPoint } | null): void;
	/** select the page in view ("page"), every page ("document"), or Cmd/Ctrl+A behaviour ("auto": page, then document) */
	selectAll(scope?: "page" | "document" | "auto"): void;
	/**
	 * Exact, case-insensitive search in document order (ligatures, quotes and
	 * whitespace folded; matches cross line and page breaks). `pages` limits it
	 * to those pages (0-based). Default limit 500. With `fuzzy`, fuzzy matches
	 * (`exact: false`, best `score` first) follow the exact ones, split within
	 * `limit` like `searchAsync`.
	 */
	search(
		query: string,
		limit?: number,
		options?: Pick<SearchOptions, "pages" | "matchDiacritics" | "ignoreHyphenation"> & { fuzzy?: { threshold?: number }; signal?: AbortSignal },
	): Promise<SearchHit[]>;
	/**
	 * Exact and fuzzy search, like lector's `searchAsync`: `{ exactMatches,
	 * fuzzyMatches, hasMoreResults }`. Pages are searched as their text is
	 * extracted; `onProgress` gets partial results along the way. Aborting the
	 * signal (or `cancelSearch`) rejects with an `AbortError`.
	 */
	searchAsync(query: string, options?: SearchOptions & { signal?: AbortSignal; onProgress?: (partial: SearchResults) => void }): Promise<SearchResults>;
	/** cancel every running search */
	cancelSearch(): void;
	/** a search is running */
	readonly isSearching: boolean;
	outline(): Promise<OutlineItem[]>;
	/**
	 * The markup annotations already in the file on a page (0-based): highlights,
	 * underlines, notes with their replies, ink, free text, shapes. Read once per
	 * page. Tiles paint all of them except notes (Text and Popup annotations),
	 * whose icons the host draws.
	 */
	annotations(page: number): Promise<PdfAnnotation[]>;
	/**
	 * Figures, charts, diagrams and tables on `page` (0-based): rect in page points
	 * (axis labels included, caption not), kind, and the caption and its label
	 * ("Figure 3") when one is found. Detected on a raster worker, once per page.
	 */
	pageFigures(page: number): Promise<PageFigure[]>;
	pageText(page: number): Promise<string>;
	/** page text plus `chars[i]`: the char index (for `rects`) of UTF-16 unit `i` */
	pageTextMap(page: number): Promise<{ text: string; chars: Int32Array }>;
	/** rects (page points, one per line) of chars [from, to) on a page */
	rects(page: number, from: number, to: number): Promise<Rect[]>;
	/** a rendered page at `width` device pixels, for thumbnails */
	thumbnail(page: number, width: number): Promise<ImageBitmap | null>;
	/** a copy of the document bytes, as loaded (form edits not included; see `saveDocument`) */
	getData(): Promise<Uint8Array>;
	/** the document bytes with the form fields as filled in (an open field edit is committed first) */
	saveDocument(): Promise<Uint8Array>;
	setHighlights(items: Extract<Command, { type: "highlights" }>["items"]): void;
	clearSelection(): void;
	setOptions(options: Partial<CoreOptions>): void;
	/**
	 * Retry opening an encrypted document after an `error` event with code
	 * `password`. Resolves true once it opens (a `ready` event follows), false
	 * for a wrong password (another `password` error is emitted too).
	 */
	unlock(password: string): Promise<boolean>;
	/** text of the current selection ("" when nothing is selected) */
	readonly selectedText: string;
	destroy(): void;
}

export interface RevealOptions {
	animate?: boolean;
	align?: RevealAlign;
	ifNeeded?: boolean;
	/** css px added to where the rect lands (positive moves it down), e.g. under a sticky header */
	offset?: number;
}

/** Errors mirror pdf.js wording so hosts that pattern-match load failures keep working. */
async function fetchPdf(url: string, init: RequestInit = {}) {
	let res: Response;
	try {
		res = await fetch(url, { credentials: "same-origin", ...init });
	} catch (err) {
		throw new EngineError(`Failed to fetch PDF "${url}": ${String((err as Error)?.message ?? err)}`, "fetch", "document-load", url);
	}
	if (!res.ok) throw new EngineError(`Unexpected server response (${res.status}) while retrieving PDF "${url}".`, "fetch", "document-load", url);
	return res;
}

class ServerResponse extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

/** The whole file. A dropped connection (before or mid-body) or a retryable status fetches it again; errors read as `fetchPdf`'s. */
async function downloadPdf(url: string, init: RequestInit = {}, onResponse?: (res: Response) => void): Promise<Blob> {
	try {
		return await retrying(
			async () => {
				const res = await fetch(url, { credentials: "same-origin", ...init });
				onResponse?.(res);
				if (!res.ok) {
					void res.body?.cancel().catch(() => {});
					throw new ServerResponse(res.status);
				}
				return await res.blob();
			},
			(err) => (err instanceof ServerResponse ? retryableStatus(err.status) : isNetworkError(err)),
			{ signal: init.signal },
		);
	} catch (err) {
		if (err instanceof ServerResponse) throw new EngineError(`Unexpected server response (${err.status}) while retrieving PDF "${url}".`, "fetch", "document-load", url);
		throw new EngineError(`Failed to fetch PDF "${url}": ${String((err as Error)?.message ?? err)}`, "fetch", "document-load", url);
	}
}

/** bytes read from the end of the file before the workers start: trailer, xref, and the object streams pdfTeX writes there */
const TAIL_BYTES = 256 * 1024;
/** how long the download runs before its rate decides on the far tail */
const RATE_SAMPLE_MS = 150;
/** also read, in parallel, while racing a mid-size file's whole download: pdfTeX's object streams often reach further back, and a round trip costs more than the bytes */
const RACE_TAIL_BYTES = 1024 * 1024;

/** `late`: seeds still arriving when the workers start */
type Opened = { blob: Blob; mode: "download" | "whole" } | { length: number; seeds: [number, Uint8Array][]; stream?: FileStream; late?: Promise<[number, Uint8Array][]> };

/** PDF requests the main thread made while opening, and when the first answered */
export interface NetCount {
	requests: number;
	firstByteAt: number;
	/** PDF bytes the main thread received */
	bytes: number;
}

async function rangeBytes(url: string, start: number, end: number, net: NetCount, signal?: AbortSignal): Promise<Uint8Array | null> {
	try {
		net.requests++;
		// no-store: the HTTP cache lets one request per URL through at a time, which would serialise these
		const res = await fetchRetrying(url, { credentials: "same-origin", cache: "no-store", headers: { Range: `bytes=${start}-${end - 1}` }, signal });
		if (res.status !== 206) return null;
		const bytes = new Uint8Array(await res.arrayBuffer());
		net.bytes += bytes.length;
		return bytes.length === end - start ? bytes : null;
	} catch {
		return null;
	}
}

/** Reads a body until `need(bytesSoFar)` bytes have arrived (or it ends), then stops the rest. */
async function readPrefix(res: Response, need: (bytes: Uint8Array) => number): Promise<Uint8Array | null> {
	const reader = res.body?.getReader();
	if (!reader) return null;
	let buf = new Uint8Array(0);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (value) {
				const next = new Uint8Array(buf.length + value.length);
				next.set(buf);
				next.set(value, buf.length);
				buf = next;
			}
			if (done || buf.length >= need(buf)) break;
		}
	} catch {
		return null;
	} finally {
		void reader.cancel().catch(() => {});
	}
	return buf;
}

/** the most of a racing download's prefix handed to the workers as seeds (past it they wait for the whole file) */
const STREAM_SEED_MAX = 4 * 1024 * 1024;
/** the racing download's prefix goes to the workers in pieces of at least this */
const STREAM_FORWARD_BYTES = 256 * 1024;

/** The probe's body, read to the end in the background: its prefix seeds range reads, and once complete it is the file. */
class FileStream {
	buf: Uint8Array<ArrayBuffer>;
	received = 0;
	/** stopped before the end: slower than range reads, failed, or no longer wanted */
	stopped = false;
	/** bytes [0, seeded) were handed to the workers */
	seeded = 0;
	readonly whole: Promise<Blob | null>;
	onData?: () => void;
	/** called once when the rest looks slower to download than range reads would be to open */
	onSlow?: () => void;
	private firstAt = 0;
	private waiters: { pos: number; resolve: (ok: boolean) => void }[] = [];
	private reader: ReadableStreamDefaultReader<Uint8Array> | null;

	constructor(
		res: Response,
		readonly length: number,
		private rttMs: number,
		private net: NetCount,
	) {
		this.buf = new Uint8Array(length);
		this.reader = res.body?.getReader() ?? null;
		this.whole = this.pump();
	}

	private async pump(): Promise<Blob | null> {
		const reader = this.reader;
		if (!reader) return this.stop();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (this.stopped) return null;
				if (done) break;
				if (this.received + value.length > this.length) return this.stop();
				this.buf.set(value, this.received);
				this.received += value.length;
				this.net.bytes += value.length;
				this.firstAt ||= performance.now();
				this.settle();
				this.onData?.();
				if (this.received >= this.length) continue;
				const progress = { elapsedMs: performance.now() - this.firstAt, received: this.received, length: this.length, rttMs: this.rttMs };
				if (this.onSlow && rangesBeside(progress)) {
					this.onSlow();
					this.onSlow = undefined;
				}
				if (abandonWhole(progress)) return this.stop();
			}
		} catch {
			return this.stop();
		}
		if (this.received !== this.length) return this.stop();
		const blob = new Blob([this.buf], { type: "application/pdf" });
		this.buf = new Uint8Array(0);
		return blob;
	}

	stop(): null {
		if (!this.stopped) {
			this.stopped = true;
			void this.reader?.cancel().catch(() => {});
			if (this.buf.length > this.received) this.buf = this.buf.slice(0, this.received);
		}
		for (const w of this.waiters.splice(0)) w.resolve(this.received >= w.pos);
		this.onData = undefined;
		return null;
	}

	private settle() {
		this.waiters = this.waiters.filter((w) => {
			if (this.received < w.pos) return true;
			w.resolve(true);
			return false;
		});
	}

	/** true once bytes [0, pos) arrived, false if the stream stops first */
	until(pos: number): Promise<boolean> {
		if (this.received >= pos) return Promise.resolve(true);
		if (this.stopped) return Promise.resolve(false);
		return new Promise((resolve) => this.waiters.push({ pos, resolve }));
	}

	/** where the stream should be `ms` from now at its rate so far */
	reach(ms: number): number {
		if (this.stopped) return this.received;
		// headers only so far: the head is on its way
		if (!this.firstAt) return Math.min(this.length, HEAD_BYTES);
		return Math.min(this.length, this.received + (this.received / Math.max(1, performance.now() - this.firstAt)) * ms);
	}
}

/** Granules the main thread fetched, handed to every worker as seeds. */
class SeedBlocks {
	blocks = new Map<number, Uint8Array>();
	/** a whole-file download still running: spans it reaches within `waitMs` come from it instead of a new request */
	stream: FileStream | null = null;
	waitMs = 0;
	/** granule -> the request bringing it */
	private pending = new Map<number, Promise<void>>();
	constructor(
		private url: string,
		private length: number,
		private net: NetCount,
		private signal?: AbortSignal,
	) {}

	add(start: number, bytes: Uint8Array) {
		for (let s = Math.ceil(start / RANGE_GRANULE) * RANGE_GRANULE; s < start + bytes.length; s += RANGE_GRANULE) {
			const e = Math.min(this.length, s + RANGE_GRANULE);
			if (e <= start + bytes.length) this.blocks.set(s, bytes.subarray(s - start, e - start));
		}
	}

	/** Fetches the missing blocks covering each [start, end) in parallel, coalescing neighbours. */
	async ensure(spans: [number, number][]) {
		const missing = new Set<number>();
		const inFlight = new Set<Promise<unknown>>();
		for (const [start, end] of spans) {
			for (let s = Math.floor(start / RANGE_GRANULE) * RANGE_GRANULE; s < Math.min(end, this.length); s += RANGE_GRANULE) {
				const pending = this.pending.get(s);
				if (pending) inFlight.add(pending);
				else if (!this.blocks.has(s)) missing.add(s);
			}
		}
		const sorted = [...missing].sort((a, b) => a - b);
		const runs: [number, number][] = [];
		for (const s of sorted) {
			const last = runs[runs.length - 1];
			if (last && last[1] === s) last[1] = Math.min(this.length, s + RANGE_GRANULE);
			else runs.push([s, Math.min(this.length, s + RANGE_GRANULE)]);
		}
		await Promise.all([...inFlight, ...runs.map(([s, e]) => this.fetchRun(s, e))]);
	}

	private async fetchRun(s: number, e: number) {
		const request = (from: number, to: number) => {
			const p = rangeBytes(this.url, from, to, this.net, this.signal).then((b) => {
				if (b) this.add(from, b);
				for (let g = from; g < to; g += RANGE_GRANULE) this.pending.delete(g);
			});
			for (let g = from; g < to; g += RANGE_GRANULE) this.pending.set(g, p);
			return p;
		};
		const stream = this.stream;
		const reach = stream ? Math.min(e, Math.ceil(stream.reach(this.waitMs) / RANGE_GRANULE) * RANGE_GRANULE) : 0;
		if (!stream || s >= reach) return void (await request(s, e));
		const rest = reach < e ? request(reach, e) : null;
		if (await stream.until(reach)) this.add(s, stream.buf.slice(s, reach));
		else await request(s, reach);
		await rest;
	}

	bytes(start: number, end: number): Uint8Array | null {
		end = Math.min(end, this.length);
		const out = new Uint8Array(end - start);
		for (let s = Math.floor(start / RANGE_GRANULE) * RANGE_GRANULE; s < end; s += RANGE_GRANULE) {
			const b = this.blocks.get(s);
			if (!b) return null;
			const from = Math.max(start, s);
			const to = Math.min(end, s + b.length);
			out.set(b.subarray(from - s, to - s), from - start);
		}
		return out;
	}

	seeds(): [number, Uint8Array][] {
		return [...this.blocks];
	}
}

/** bytes read at an object's offset: a page dictionary, or a page tree node with its /Kids */
const OBJECT_BYTES = 4 * 1024;
const NODE_BYTES = 64 * 1024;
/** a cross-reference table larger than this is left to the workers */
const MAX_XREF_BYTES = 4 * 1024 * 1024;

/**
 * PDFium reaches a page through the page tree, reading each kid before it
 * with its own synchronous request; in a flat tree, page 300 costs 300 round
 * trips. Read that path here instead: the xref table (in the tail) gives the
 * offsets, and the kids are fetched in parallel.
 */
async function prefetchPagePath(store: SeedBlocks, tailStart: number, target: number | ((count: number) => number)) {
	const tail = store.bytes(tailStart, Number.MAX_SAFE_INTEGER);
	if (!tail) return;
	const startxref = findStartxref(tail);
	if (startxref === null || startxref >= tailStart + tail.length) return;
	if (startxref < tailStart) {
		if (tailStart - startxref > MAX_XREF_BYTES) return;
		await store.ensure([[startxref, tailStart]]);
	}
	const from = Math.floor(Math.min(startxref, tailStart) / RANGE_GRANULE) * RANGE_GRANULE;
	const table = store.bytes(from, Number.MAX_SAFE_INTEGER);
	const xref = table && parseXref(table, from, startxref);
	if (!xref) return;
	const read = async (num: number, offset: number, size = NODE_BYTES) => {
		await store.ensure([[offset, offset + size]]);
		return store.bytes(offset, offset + size);
	};
	const path = await pagePathObjects(xref, target, {
		read: (num, offset) => read(num, offset),
		readMany: async (objects) => {
			await store.ensure(objects.map(([, o]) => [o, o + OBJECT_BYTES]));
			return objects.map(([, o]) => store.bytes(o, o + OBJECT_BYTES));
		},
	});
	if (path) await store.ensure(path.map((o) => [o, o + OBJECT_BYTES]));
}

// Small files come back whole from the probe (one request beats a round trip per block); larger ones open from range reads.
export async function openUrl(
	url: string,
	range: boolean,
	firstPage: boolean,
	target: number | ((count: number) => number),
	signal: AbortSignal,
	net: NetCount,
): Promise<Opened> {
	const answered = (res: Response) => {
		net.requests++;
		net.firstByteAt ||= epochNow();
		return res;
	};
	const download = async (): Promise<Opened> => ({ blob: await downloadPdf(url, { signal }, answered), mode: "download" });
	if (!range) return download();
	const askedAt = epochNow();
	// A server that refuses the ranged request (e.g. a CORS preflight for `Range`) still serves the plain one, so the probe is not retried.
	const res = await fetchPdf(url, { headers: { Range: `bytes=0-${RACE_FILE_MAX - 1}` }, signal }).then(answered, () => null);
	if (!res) return download();
	const rttMs = epochNow() - askedAt;
	const header = (name: string) => res.headers.get(name);
	const verdict = probeVerdict({ status: res.status, contentRange: header("Content-Range"), contentEncoding: header("Content-Encoding"), contentLength: header("Content-Length") }, RACE_FILE_MAX);
	if (verdict.kind === "full-body") return { blob: await res.blob().catch(() => downloadPdf(url, { signal }, answered)), mode: "download" };
	let length = verdict.kind === "range" || verdict.kind === "whole" ? verdict.length : 0;
	if (verdict.kind === "need-length") {
		net.requests++;
		const head = await fetchRetrying(url, { method: "HEAD", credentials: "same-origin", signal }).catch(() => null);
		length = Number(head?.ok ? head.headers.get("Content-Length") : 0) || 0;
	}
	if (!length || verdict.kind === "download") {
		void res.body?.cancel().catch(() => {});
		return download();
	}
	if (length > RACE_FILE_MAX) return openRanges(url, length, res, firstPage, target, signal, net);
	return race(url, res, length, rttMs, firstPage, target, signal, net);
}

/**
 * The probe keeps downloading the whole file while range reads (seeded from
 * its prefix) open the document; the first to be ready wins. Mid-size files
 * start range reads at once; small ones only once the download looks slow.
 */
async function race(
	url: string,
	res: Response,
	length: number,
	rttMs: number,
	firstPage: boolean,
	target: number | ((count: number) => number),
	signal: AbortSignal,
	net: NetCount,
): Promise<Opened> {
	const stream = new FileStream(res, length, rttMs, net);
	const ranging = new AbortController();
	signal.addEventListener(
		"abort",
		() => {
			stream.stop();
			ranging.abort();
		},
		{ once: true },
	);
	const eager = length > WHOLE_FILE_MAX;
	let viaRanges: Promise<Opened> | null = null;
	const ranges = () => (viaRanges ??= openRanges(url, length, stream, firstPage, target, ranging.signal, net, rttMs, eager));
	const slow = eager ? Promise.resolve() : new Promise<void>((resolve) => (stream.onSlow = resolve));
	const viaWhole = stream.whole.then((blob): Opened | Promise<Opened> => (blob ? { blob, mode: "whole" } : ranges()));
	const opened = await Promise.race([slow.then(ranges).catch(() => viaWhole), viaWhole]);
	if ("blob" in opened) ranging.abort();
	if (!("seeds" in opened) && opened.mode !== "whole") stream.stop();
	return opened;
}

/** whether the download's rate, once measurable, brings `bytes` within a round trip: on a slow link the far tail would only compete */
async function farTailWorthIt(stream: FileStream, rttMs: number, bytes: number): Promise<boolean> {
	if (!(await stream.until(1))) return false;
	await new Promise((resolve) => setTimeout(resolve, RATE_SAMPLE_MS));
	return stream.reach(rttMs) - stream.received >= bytes;
}

/** Head and tail blocks (and the page path) for the workers to start from; `head` is the file's first bytes or the probe still streaming them. */
async function openRanges(
	url: string,
	length: number,
	head: Uint8Array | Response | FileStream,
	firstPage: boolean,
	target: number | ((count: number) => number),
	signal: AbortSignal,
	net: NetCount,
	rttMs = 0,
	farTail = false,
): Promise<Opened> {
	const store = new SeedBlocks(url, length, net, signal);
	if (head instanceof FileStream) {
		store.stream = head;
		store.waitMs = rttMs;
	}
	const tailStart = Math.floor(Math.max(0, length - TAIL_BYTES) / RANGE_GRANULE) * RANGE_GRANULE;
	const tail = store.ensure([[tailStart, length]]);
	const farStart = Math.floor(Math.max(0, length - RACE_TAIL_BYTES) / RANGE_GRANULE) * RANGE_GRANULE;
	const far = farTail && head instanceof FileStream && farStart < tailStart ? farTailWorthIt(head, rttMs, tailStart - farStart).then((yes) => (yes ? store.ensure([[farStart, tailStart]]) : undefined)) : null;
	const headBytes =
		head instanceof Response ? await readPrefix(head, (bytes) => probeReadBytes(bytes.length >= HEAD_BYTES ? readLinearization(bytes, length) : null, firstPage, length)) : head instanceof Uint8Array ? head : null;
	if (headBytes) store.add(0, headBytes);
	await Promise.all([tail, store.ensure([[0, Math.min(HEAD_BYTES, length)]])]);
	const first = store.bytes(0, Math.min(HEAD_BYTES, length));
	if (!first) return { blob: await downloadPdf(url, { signal }), mode: "download" };
	const lin = readLinearization(first, length);
	if (lin && firstPage) await store.ensure([[0, probeReadBytes(lin, true, length)]]);
	else await prefetchPagePath(store, tailStart, target).catch(() => {});
	if (!(head instanceof FileStream)) return { length, seeds: store.seeds() };
	head.seeded = Math.floor(Math.min(head.received, STREAM_SEED_MAX) / RANGE_GRANULE) * RANGE_GRANULE;
	store.add(0, head.buf.slice(0, head.seeded));
	const seeds = store.seeds();
	const sent = new Set(seeds.map(([start]) => start));
	const late = far?.then(() => [...store.blocks].filter(([start]) => start >= farStart && start < tailStart && !sent.has(start)));
	return { length, seeds, stream: head, late };
}

function isPending(source: ViewerSource): source is PromiseLike<string | ArrayBuffer | Uint8Array> {
	return typeof source === "object" && source !== null && typeof (source as PromiseLike<unknown>).then === "function";
}

/** the other raster workers wait at most this long for the first one to open the document */
const STAGGER_MAX_MS = 3000;

/** presses closer than this (ms, css px) count as a double/triple click */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 6;

/** a touch on a form field fills it in when it stays within this (css px, ms) */
const FORM_TAP_SLOP = 10;
const FORM_TAP_MS = 600;

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", " ", "Escape"]);

const compiled = new Map<string, Promise<WebAssembly.Module | undefined>>();

/**
 * Compiles pdfium.wasm once per page and URL; every raster worker of every
 * viewer instantiates that module instead of downloading and compiling its own.
 * Call it early (e.g. on hover) to take the compile off the open path.
 */
export function preloadPdfium(wasmUrl: string): Promise<WebAssembly.Module | undefined> {
	const url = new URL(wasmUrl, location.href).href;
	let module = compiled.get(url);
	if (!module) {
		const fetchIt = () => fetch(url, { credentials: "same-origin" }).then((res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res;
		});
		module = (typeof WebAssembly.compileStreaming === "function"
			? fetchIt().then((res) =>
					(res.headers.get("Content-Type") ?? "").split(";")[0]!.trim() === "application/wasm" ? WebAssembly.compileStreaming(res) : res.arrayBuffer().then((b) => WebAssembly.compile(b)),
				)
			: fetchIt().then((res) => res.arrayBuffer()).then((b) => WebAssembly.compile(b))
		).catch(() => {
			// Workers fall back to loading it themselves; a later viewer may retry.
			compiled.delete(url);
			return undefined;
		});
		compiled.set(url, module);
	}
	return module;
}

/** What the main thread posts to the compositor worker before and after init. */
type CoreMsg = { t: "input"; msg: InputMsg } | { t: "command"; cmd: Command } | { t: "hidden"; hidden: boolean } | { t: "canvas"; canvas: OffscreenCanvas } | { t: "canvas-failed"; reason: string };

/** A URL, the file's bytes, or a promise of either (e.g. a download the host started before the viewer). */
export type ViewerSource = string | ArrayBuffer | Uint8Array | PromiseLike<string | ArrayBuffer | Uint8Array>;

export async function createViewer(container: HTMLElement, source: ViewerSource, options: ViewerOptions): Promise<Viewer> {
	const support = getEngineSupport();
	if (!support.supported) {
		throw new EngineError(
			`lector-engine is not supported in this browser (missing: ${support.missing.join(", ")}). Check isEngineSupported() and fall back to another viewer.`,
			"unsupported",
			"engine-load",
		);
	}
	const {
		wasmUrl: wasmUrlOption,
		workers: workerCount,
		offscreen: wantOffscreen,
		onEvent,
		onLink,
		createWorker,
		workerUrls,
		password,
		rangeLoading = false,
		autoFetch = true,
		textLayer: wantTextLayer = true,
		interceptFind = false,
		tileCache = false,
		compositor: wantCompositor = "auto",
		...rest
	} = options;
	const compositor = wantCompositor === "auto" ? support.compositor : wantCompositor;
	let compositorNow: CompositorKind = compositor;
	const coreOptions = { ...rest, compositor, compositorFallback: wantCompositor === "auto" };
	const startedAt = epochNow();
	// Workers may run from blob: URLs (host loaders), where relative URLs don't resolve.
	const wasmUrl = new URL(wasmUrlOption, location.href).href;
	// One Blob shared by every raster worker (posting a Blob does not copy it);
	// workers read blocks from it on demand. Range loading starts from the URL.
	// The workers start (and compile pdfium) while the file downloads.
	let blob: Blob | null = null;
	let docSource: DocSource | null = null;
	let fetchMs = 0;
	let fetchBytes = 0;
	let loadMode: LoadTimings["loadMode"] = "memory";
	let fileBytes = 0;
	const net: NetCount = { requests: 0, firstByteAt: 0, bytes: 0 };
	let stream: FileStream | null = null;
	let lateSeeds: Promise<[number, Uint8Array][]> | null = null;
	const target = coreOptions.initialTarget;
	const targetPage = target && "page" in target ? target.page : (coreOptions.initialPage ?? 0);
	const targetFraction = target && "fraction" in target ? target.fraction : undefined;
	const sizeHint: SizeHint = { all: false, pages: [targetPage], fraction: targetFraction };
	let opening: Promise<void>;
	// Every download this viewer starts (probe, seeds, the background full file) stops with it.
	const network = new AbortController();
	let sourceUrl: string | undefined;
	const open = (resolved: string | ArrayBuffer | Uint8Array): Promise<void> => {
		if (typeof resolved !== "string") {
			blob = new Blob([(resolved instanceof Uint8Array ? resolved : new Uint8Array(resolved)) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
			fileBytes = blob.size;
			docSource = { kind: "blob", blob };
			return Promise.resolve();
		}
		const absolute = new URL(resolved, location.href).href;
		sourceUrl = absolute;
		const firstPage = targetFraction === undefined && !coreOptions.initialOffset && !coreOptions.initialCamera && !targetPage;
		const pathTarget = targetFraction !== undefined ? (count: number) => targetFraction * count : targetPage;
		return openUrl(absolute, rangeLoading, firstPage, pathTarget, network.signal, net).then((opened) => {
			if ("blob" in opened) blob = opened.blob;
			else {
				stream = opened.stream ?? null;
				lateSeeds = opened.late ?? null;
			}
			loadMode = "blob" in opened ? opened.mode : stream ? "race" : "range";
			fetchBytes = blob?.size ?? (opened as { seeds: [number, Uint8Array][] }).seeds.reduce((sum, [, b]) => sum + b.length, 0);
			fileBytes = blob?.size ?? (opened as { length: number }).length;
			docSource = blob
				? { kind: "blob", blob }
				: { kind: "url", url: absolute, length: (opened as { length: number }).length, credentials: new URL(absolute).origin === location.origin, seeds: (opened as { seeds: [number, Uint8Array][] }).seeds };
		});
	};
	const pending = isPending(source);
	if (typeof source === "string") sourceUrl = new URL(source, location.href).href;
	// The workers boot (and pdfium compiles) while a pending source settles; fetchMs is that wait plus any download after it.
	opening = (
		pending
			? Promise.resolve(source).then(open, (err: unknown) => {
					throw err instanceof EngineError ? err : new EngineError(`Failed to fetch PDF: ${String((err as Error)?.message ?? err)}`, "fetch", "document-load");
				})
			: open(source)
	).then(() => {
		if (pending || typeof source === "string") fetchMs = epochNow() - startedAt;
		if (pending && !fetchBytes) fetchBytes = blob?.size ?? 0;
	});
	opening.catch(() => {});
	/**
	 * Runs a host callback. A throwing callback must not break the engine (the
	 * core emits from inside its frame loop and teardown paths), so the error is
	 * reported like an uncaught one instead of propagating.
	 */
	const host = (fn: () => void) => {
		try {
			fn();
		} catch (err) {
			if (typeof reportError === "function") reportError(err);
			else setTimeout(() => {
				throw err;
			});
		}
	};
	// Everything acquired from here on is released in reverse order by `destroy`,
	// or right away if construction fails part-way (the caller gets no viewer).
	const cleanups: (() => void)[] = [() => network.abort()];
	let destroyed = false;
	const release = () => {
		for (const fn of cleanups.splice(0).reverse()) {
			try {
				fn();
			} catch (err) {
				console.error(err);
			}
		}
	};
	let viewer: Viewer;
	try {
		viewer = build();
	} catch (err) {
		destroyed = true;
		release();
		throw err;
	}
	try {
		await opening;
	} catch (err) {
		destroyed = true;
		release();
		throw err;
	}
	return viewer;

	function build(): Viewer {
		const workerType: WorkerType = support.moduleWorkers ? "module" : "classic";
		const spawn = (kind: "raster" | "core", name: string, onmessage: (ev: MessageEvent) => void, onLoadFailed: (ev: ErrorEvent) => void) => {
			const url = workerUrls?.[kind];
			// Literal `new Worker(new URL(...))` so bundlers emit the worker chunks.
			const bundled = () =>
				workerType === "module"
					? kind === "raster"
						? new Worker(new URL("./raster-worker.ts", import.meta.url), { type: "module", name })
						: new Worker(new URL("./core-worker.ts", import.meta.url), { type: "module", name })
					: kind === "raster"
						? new Worker(new URL("./raster-worker.ts", import.meta.url), { name })
						: new Worker(new URL("./core-worker.ts", import.meta.url), { name });
			const create = (attempt: number) => {
				if (!url) return bundled();
				const href = retryUrl(new URL(url, location.href), attempt);
				return createWorker ? createWorker(href, name, { type: workerType }) : new Worker(href, { type: workerType, name });
			};
			return startWorker({
				create,
				onmessage,
				stopped: () => destroyed,
				onLoadFailed,
				onCrashed: (ev) => workerFailed(name, ev),
			});
		};
		/** A worker that is required, or threw outside a request, is terminal: requests to it would never answer. */
		const workerFailed = (name: string, ev: ErrorEvent) => {
			const message = `lector-engine: ${name} worker failed${ev.message ? `: ${ev.message}` : " to load"}`;
			const phase = opened ? "render" : "engine-load";
			// Tear down first (settling every promise), then tell the host.
			teardown(new EngineError(message, "worker", phase, sourceUrl));
			handleEvent({ type: "error", message, code: "worker", phase });
		};
		let fullFetch: Promise<Blob> | null = null;
		const arrived = (b: Blob) => {
			if (blob) return blob;
			blob = b;
			for (const w of rasterWorkers) w().postMessage({ t: "source", blob: b });
			command({ type: "remote", on: false });
			return b;
		};
		const fetchAll = (): Promise<Blob> => {
			if (blob) return Promise.resolve(blob);
			if (fullFetch) return fullFetch;
			// a racing download still running is the full fetch
			if (stream && !stream.stopped) {
				fullFetch = stream.whole.then((b) => {
					fullFetch = null;
					return b ? arrived(b) : fetchAll();
				});
				return fullFetch;
			}
			const url = (docSource as { url: string }).url;
			// Low priority: it must not slow down range requests for what is on screen.
			fullFetch = downloadPdf(url, { priority: "low", signal: network.signal } as RequestInit).then(arrived, (err) => {
				fullFetch = null;
				throw err;
			});
			return fullFetch;
		};
		// The racing download's prefix keeps seeding the workers, and once complete it is their source.
		void opening.then(
			() => {
				const s = stream;
				if (!s) return;
				s.onData = () => {
					const upTo = Math.floor(Math.min(s.received, STREAM_SEED_MAX) / RANGE_GRANULE) * RANGE_GRANULE;
					if (upTo <= s.seeded || (upTo - s.seeded < STREAM_FORWARD_BYTES && upTo < STREAM_SEED_MAX)) return;
					const start = s.seeded;
					s.seeded = upTo;
					for (const w of rasterWorkers) {
						const data = s.buf.slice(start, upTo);
						w().postMessage({ t: "block", start, data }, [data.buffer]);
					}
				};
				void s.whole.then((b) => b && !destroyed && arrived(b));
				void lateSeeds?.then((seeds) => {
					if (destroyed || blob) return;
					for (const w of rasterWorkers)
						for (const [start, bytes] of seeds) {
							const data = bytes.slice();
							w().postMessage({ t: "block", start, data }, [data.buffer]);
						}
				});
			},
			() => {},
		);

		const canvas = document.createElement("canvas");
		let display = canvas;
		// Sized in px from `resized` events, so the browser never stretches a stale
		// buffer while a resize is in flight (the "jelly" look).
		canvas.style.cssText = "position:absolute;left:0;top:0;display:block;touch-action:none;";
		const style = container.style;
		const saved = [style.position, style.overflow, style.touchAction, style.userSelect, style.getPropertyValue("-webkit-user-select"), style.getPropertyValue("-webkit-touch-callout")];
		const tabIndex = container.getAttribute("tabindex");
		cleanups.push(() => {
			[style.position, style.overflow, style.touchAction, style.userSelect] = saved as [string, string, string, string];
			style.setProperty("-webkit-user-select", saved[4]!);
			style.setProperty("-webkit-touch-callout", saved[5]!);
			if (tabIndex === null) container.removeAttribute("tabindex");
			else container.setAttribute("tabindex", tabIndex);
		});
		if (getComputedStyle(container).position === "static") container.style.position = "relative";
		container.style.overflow = "hidden";
		container.style.touchAction = "none";
		container.style.userSelect = "none";
		(container.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = "none";
		// iOS: no native callout/magnifier on long-press; the engine selects text itself.
		container.style.setProperty("-webkit-touch-callout", "none");
		if (container.tabIndex < 0) container.tabIndex = 0;
		canvas.setAttribute("aria-hidden", "true");
		container.appendChild(canvas);
		cleanups.push(() => canvas.remove());
		container.dataset.compositor = compositorNow;
		cleanups.push(() => delete container.dataset.compositor);
		const overlay = document.createElement("div");
		overlay.className = "lector-overlay";
		overlay.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2;";
		const failedPages = new FailedPages(container);
		cleanups.push(() => failedPages.destroy());

		// Raster workers, each with a port to the core. They share the document
		// source. Phones and tablets: each worker still holds PDFium's heap, and iOS
		// kills tabs that hold a few hundred MB, so use fewer of everything.
		const touchDevice = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
		// Camera flights jump instantly for people who asked for less motion.
		const motionQuery = coreOptions.reducedMotion === undefined && typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
		if (motionQuery) coreOptions.reducedMotion = motionQuery.matches;
		if (touchDevice) coreOptions.textureBudgetMB ??= 128;
		const software = compositor === "canvas2d" && (support.softwareGL || !support.webgl2);
		const n = workerCount ?? rasterWorkerCount({ cores: navigator.hardwareConcurrency, memoryGB: (navigator as { deviceMemory?: number }).deviceMemory, touch: touchDevice, software });
		const rasterWorkers: (() => Worker)[] = [];
		/** the worker currently serving each pool lane */
		const laneWorkers: (() => Worker)[] = [];
		const corePorts: MessagePort[] = [];
		const lanePorts: MessagePort[] = [];
		cleanups.push(() => {
			for (const w of rasterWorkers) w().terminate();
			for (const port of [...corePorts, ...lanePorts]) port.close();
		});
		// Only a module someone already compiled (preloadPdfium) is shared; compiling it here would land on the open path's main thread.
		const pdfium = compiled.get(wasmUrl) ?? Promise.resolve(undefined);
		/** workers that start late (after the first opened) need the password that worked, not the initial one */
		let latestPassword = password;
		let resolveFirstOpened: () => void = () => {};
		// With range loading the other workers start once the first has parsed the file, from the blocks it shared.
		const firstOpened = new Promise<void>((resolve) => {
			resolveFirstOpened = resolve;
		});
		// A block one worker downloaded goes to the others, so each byte crosses the network once.
		const relay = (ev: MessageEvent<ToRaster | { t: "opened" }>) => {
			if (ev.data?.t === "opened") resolveFirstOpened();
			if (ev.data?.t !== "block") return;
			workerRequests++;
			workerBytes += ev.data.data.length;
			for (const w of rasterWorkers) if (w() !== ev.target) w().postMessage(ev.data);
		};
		let workerRequests = 0;
		let workerBytes = 0;
		const buildAt = epochNow();
		let wasmWaitMs = 0;
		let workerBootMs = 0;
		void pdfium.then(() => {
			wasmWaitMs = epochNow() - buildAt;
		});
		for (let i = 0; i < n; i++) {
			const channel = new MessageChannel();
			corePorts.push(channel.port2);
			lanePorts.push(channel.port1);
		}
		/** Sends a booted worker its init for lane `i`; `restart`: it replaces a worker whose PDFium could not restart, or could not reserve memory (`lowMemory`) */
		const initLane = (worker: Worker, i: number, port: MessagePort, restart = false, lowMemory = false) => {
			Promise.all([pdfium, opening.then(() => (i > 0 && !blob ? Promise.race([firstOpened, new Promise((r) => setTimeout(r, STAGGER_MAX_MS))]) : undefined))]).then(([module]) => {
				if (destroyed) return;
				// A full file that arrived before this worker (e.g. after a retry or respawn) replaces range requests.
				const first = restart ? !opened : i === 0;
				const sizes: SizeHint | undefined = !first ? undefined : blob ? { all: true } : sizeHint;
				// the racing download finished first: the document opens from it
				if (i === 0 && blob && loadMode === "race") loadMode = "whole";
				const init: ToRaster = { t: "init", source: blob ? { kind: "blob", blob } : docSource!, port, wasmUrl, password: latestPassword, sizes, ...(lowMemory && { lowMemory }) };
				try {
					worker.postMessage(module && !lowMemory ? { ...init, module } : init, [port]);
				} catch {
					// a browser that cannot clone compiled modules to workers
					worker.postMessage(init, [port]);
				}
			}, () => {});
		};
		let lanesTaken = 0;
		let lostWorkers = 0;
		const workerLost = (name: string, ev: ErrorEvent) => {
			if (++lostWorkers === n) workerFailed(name, ev);
		};
		// Workers take lanes in boot order, so the document opens on whichever loads first; the pool skips lanes nobody took.
		for (let k = 0; k < n; k++) {
			const { current, booted } = spawn("raster", `lector-raster-${k}`, relay, (ev) => workerLost(`lector-raster-${k}`, ev));
			rasterWorkers.push(current);
			void booted.then((worker) => {
				if (destroyed) return;
				const i = lanesTaken++;
				if (i === 0) workerBootMs = epochNow() - buildAt;
				laneWorkers[i] = current;
				initLane(worker, i, lanePorts[i]!);
			});
		}
		/** A fresh worker for lane `i`; returns the port the core's end of that lane switches to. */
		const restartRaster = (i: number, lowMemory: boolean) => {
			const channel = new MessageChannel();
			const { current, booted } = spawn("raster", `lector-raster-${i}`, relay, (ev) => workerLost(`lector-raster-${i}`, ev));
			rasterWorkers.push(current);
			laneWorkers[i] = current;
			void booted.then((worker) => {
				if (!destroyed) initLane(worker, i, channel.port1, true, lowMemory);
			});
			return channel.port2;
		};

		let selectedText = "";
		let opened = false;
		let readyAt = 0;
		let openTiming: OpenTiming | undefined;
		let loadTimings: LoadTimings | null = null;
		let resolveLoaded: (v: { pages: PageSize[]; info: DocumentInfo }) => void = () => {};
		let rejectLoaded: (err: EngineError) => void = () => {};
		const loaded = new Promise<{ pages: PageSize[]; info: DocumentInfo }>((resolve, reject) => {
			resolveLoaded = resolve;
			rejectLoaded = reject;
		});
		// Hosts that only listen to events must not see an unhandled rejection.
		loaded.catch(() => {});
		let resolved: CoreOptions = { ...defaultOptions, ...coreOptions };
		let camera: Camera = { x: 0, y: 0, zoom: 1 };
		let layout: Rect[] = [];
		let viewH = 0;
		let textLayer: TextLayer | null = null;
		let forms: FormLayer | null = null;
		/** the cursor the core asked for (a widget under the mouse overrides it) */
		let coreCursor = "default";
		let overWidget = false;
		const unlocks: ((ok: boolean) => void)[] = [];
		/** requests waiting for a `response` event */
		const pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
		/** set once the viewer cannot answer requests any more (destroyed, or the document or engine failed to load) */
		let dead: EngineError | null = null;
		/** Rejects every waiting request, `loaded` and unlock with `err`; later requests reject right away. */
		const fail = (err: EngineError) => {
			dead ??= err;
			if (!opened) rejectLoaded(err);
			for (const resolve of unlocks.splice(0)) resolve(false);
			for (const resolve of flights.values()) resolve(false);
			flights.clear();
			for (const [id, p] of [...pending]) {
				pending.delete(id);
				p.reject(err);
			}
		};
		/** Settles everything with `err` and releases every resource (destroy, or a dead worker). */
		const teardown = (err: EngineError) => {
			if (destroyed) return;
			destroyed = true;
			fail(err);
			release();
			core = null;
			postToCore = () => {};
		};
		/** A new display canvas under the old one, which stays on top, transparent, so input listeners and pointer capture keep working. */
		const freshCanvas = () => {
			const fresh = document.createElement("canvas");
			fresh.style.cssText = canvas.style.cssText;
			fresh.setAttribute("aria-hidden", "true");
			if (display !== canvas) display.remove();
			canvas.before(fresh);
			canvas.style.opacity = "0";
			display = fresh;
			cleanups.push(() => fresh.remove());
			return fresh;
		};
		const progressFns = new Map<number, (r: SearchResults) => void>();
		const flights = new Map<number, (landed: boolean) => void>();
		const handleEvent = (e: CoreEvent) => {
			if (e.type === "need-canvas") {
				const fresh = freshCanvas();
				try {
					if (offscreenNow) {
						const off = fresh.transferControlToOffscreen();
						postToCore({ t: "canvas", canvas: off }, [off]);
					} else core?.swapCanvas(fresh);
				} catch (err) {
					const reason = String((err as Error)?.message ?? err);
					if (offscreenNow) postToCore({ t: "canvas-failed", reason });
					else core?.canvasFailed(reason);
				}
				return;
			}
			if (e.type === "raster-worker") {
				if (destroyed) return;
				laneWorkers[e.index]?.().terminate();
				if (e.action === "retire") {
					// workers waiting to parse from the first one's blocks stop waiting
					resolveFirstOpened();
					return;
				}
				const port = restartRaster(e.index, e.lowMemory);
				if (core) core.replaceRaster(e.index, port);
				else postToCore({ t: "raster-port", index: e.index, port }, [port]);
				return;
			}
			if (e.type === "compositor") {
				compositorNow = e.kind;
				container.dataset.compositor = e.kind;
			}
			if (e.type === "resized") {
				canvas.style.width = `${e.w}px`;
				canvas.style.height = `${e.h}px`;
				display.style.width = `${e.w}px`;
				display.style.height = `${e.h}px`;
				textLayer?.setViewport(e.w, e.h);
				viewH = e.h;
			} else if (e.type === "camera") {
				camera = e.camera;
				failedPages.setCamera(e.camera);
				textLayer?.setCamera(e.camera, e.moving && compositorNow === "canvas2d");
				forms?.update();
			}
			else if (e.type === "cursor") {
				coreCursor = e.cursor;
				if (!overWidget) container.style.cursor = e.cursor;
			}
			else if (e.type === "form-widgets") forms?.setWidgets(e.page, e.widgets);
			else if (e.type === "form-change") forms?.changed(e.name, e.value);
			else if (e.type === "form-painted") forms?.painted(e.page);
			else if (e.type === "selection") {
				if (e.final) selectedText = e.selection?.text ?? "";
			} else if (e.type === "link") {
				if (onLink) host(() => onLink(e.url));
				else if (/^(https?|mailto):/i.test(e.url)) window.open(e.url, "_blank", "noopener,noreferrer");
			} else if (e.type === "flight") {
				flights.get(e.id)?.(e.landed);
				flights.delete(e.id);
			} else if (e.type === "painted") {
				// Range loading: the first page is up; now fetch the rest in the background.
				if (autoFetch && !blob) void fetchAll().catch(() => {});
				else if (!autoFetch && !loadTimings) stream?.stop();
				if (!loadTimings && readyAt) {
					const paintedAt = e.timing?.paintedAt ?? epochNow();
					loadTimings = {
						fetchMs,
						fetchBytes,
						wasmWaitMs,
						workerBootMs,
						...openTiming,
						readyMs: readyAt - startedAt,
						firstTileMs: (e.timing?.firstTileAt ?? paintedAt) - startedAt,
						firstPaintMs: paintedAt - startedAt,
						tileCacheHits: e.timing?.cacheHits ?? 0,
						rangeLoading: docSource?.kind === "url",
						loadMode,
						fileKB: Math.round(fileBytes / 1024),
						requestsBeforePaint: net.requests + workerRequests,
						kbBeforePaint: Math.round((loadMode === "range" ? fetchBytes + workerBytes : loadMode === "race" ? net.bytes + workerBytes : loadMode === "memory" ? 0 : fileBytes) / 1024),
						ttfbMs: net.firstByteAt ? net.firstByteAt - startedAt : 0,
					};
					if (onEvent) {
						const load: CoreEvent = { type: "load", timings: loadTimings };
						queueMicrotask(() => host(() => onEvent(load)));
					}
				}
			} else if (e.type === "ready") {
				readyAt ||= epochNow();
				openTiming = e.timing;
				opened = true;
				layout = e.layout;
				failedPages.setLayout(e.layout);
				resolveLoaded({ pages: e.pages, info: e.info });
				textLayer?.setLayout(e.layout);
				for (const resolve of unlocks.splice(0)) resolve(true);
			} else if (e.type === "page-failed" && e.phase === "render") {
				failedPages.add(e.page);
				failedPages.setCamera(camera);
			} else if (e.type === "layout") {
				layout = e.layout;
				failedPages.setLayout(e.layout);
				textLayer?.setLayout(e.layout);
				forms?.update();
			} else if (e.type === "error" && e.code === "password" && e.phase === "document-load") {
				for (const resolve of unlocks.splice(0)) resolve(false);
			} else if (e.type === "error" && (e.phase === "document-load" || e.phase === "engine-load") && !opened) {
				// Fatal: nothing will answer requests (a worker that did not load, a document that cannot open).
				fail(new EngineError(e.message, e.code, e.phase, sourceUrl));
			} else if (e.type === "search-progress") {
				const fn = progressFns.get(e.id);
				if (fn) host(() => fn(e.results));
			}
			else if (e.type === "response") {
				const p = pending.get(e.id);
				pending.delete(e.id);
				p?.resolve(e.result);
				return;
			}
			if (onEvent) host(() => onEvent(e));
		};

		// Probed, not just feature-tested: Safari 16.4-16.x can transfer a canvas
		// but has no WebGL on OffscreenCanvas, so it composites on the main thread.
		let offscreenNow = (wantOffscreen ?? true) && support.offscreenBy[compositor];
		let postToCore: (msg: unknown, transfer?: Transferable[]) => void = () => {};
		let core: ViewerCore | null = null;
		const debug = !!(globalThis as { __lectorEngineDebug?: boolean }).__lectorEngineDebug;
		const mainThreadCore = (target: HTMLCanvasElement) => {
			try {
				core = new ViewerCore(target, corePorts, handleEvent, (cb) => requestAnimationFrame(cb), coreOptions, software);
			} catch (err) {
				throw new EngineError(`lector-engine: no WebGL2 context: ${String((err as Error)?.message ?? err)}`, "gpu", "engine-load");
			}
			const c = core;
			const g = globalThis as { __core?: ViewerCore };
			cleanups.push(() => {
				c.dispose();
				if (g.__core === c) delete g.__core;
			});
			// Debugging and benches only: set globalThis.__lectorEngineDebug before createViewer.
			if (debug) g.__core = core;
			return c;
		};
		if (offscreenNow) {
			const offscreen = canvas.transferControlToOffscreen();
			// Input posted before boot queues here until the compositor exists.
			const pendingInput: CoreMsg[] = [];
			postToCore = (msg) => pendingInput.push(msg as CoreMsg);
			const spawned = spawn(
				"core",
				"lector-compositor",
				(ev: MessageEvent<CoreEvent | { t: "boot" }>) => {
					if ("type" in ev.data) handleEvent(ev.data);
				},
				(ev) => {
					// The compositor script never loaded: composite on the main thread instead, on a canvas that was not transferred.
					offscreenNow = false;
					postToCore = () => {};
					try {
						const c = mainThreadCore(freshCanvas());
						for (const m of pendingInput.splice(0)) {
							if (m.t === "input") c.handle(m.msg);
							else if (m.t === "command") c.command(m.cmd);
							else if (m.t === "hidden") c.setHidden(m.hidden);
						}
					} catch {
						workerFailed("lector-compositor", ev);
					}
				},
			);
			cleanups.push(() => {
				if (!offscreenNow) return;
				// The worker disposes its core (GPU resources, ports, timers) and closes itself.
				const worker = spawned.current();
				worker.postMessage({ t: "dispose" });
				setTimeout(() => worker.terminate(), 1000);
			});
			spawned.booted.then((worker) => {
				if (destroyed) return;
				worker.postMessage({ t: "init", canvas: offscreen, ports: corePorts, options: coreOptions, debug, software }, [offscreen, ...corePorts]);
				for (const msg of pendingInput.splice(0)) worker.postMessage(msg);
				postToCore = (msg, transfer = []) => worker.postMessage(msg, transfer);
			});
		} else mainThreadCore(canvas);

		const syncHidden = () => {
			const hidden = document.visibilityState === "hidden";
			if (core) core.setHidden(hidden);
			else postToCore({ t: "hidden", hidden });
		};
		syncHidden();
		document.addEventListener("visibilitychange", syncHidden);
		cleanups.push(() => document.removeEventListener("visibilitychange", syncHidden));

		const send = (msg: InputMsg) => {
			if (core) core.handle(msg);
			else postToCore({ t: "input", msg });
		};
		const command = (cmd: Command) => {
			if (core) core.command(cmd);
			else postToCore({ t: "command", cmd });
		};
		if (tileCache) {
			const { key, budgetMB = touchDevice ? 24 : 64 } = tileCache === true ? {} : tileCache;
			// a downloaded URL's blob exists only once `opening` resolves
			void opening
				.then(() => key ?? (blob ? documentKey(blob) : null))
				.then((k) => {
					if (k && !destroyed) command({ type: "tile-cache", key: k, budgetMB });
				}, () => {});
		}
		let nextFlight = 1;
		const flight = (make: (id: number) => Command) =>
			new Promise<boolean>((resolve) => {
				if (destroyed || dead) {
					resolve(false);
					return;
				}
				const id = nextFlight++;
				// Registered first: an instant jump answers synchronously on the main thread.
				flights.set(id, resolve);
				command(make(id));
			});
		let nextRequest = 1;
		const request = <T>(req: Request, started?: (id: number) => void) =>
			new Promise<T>((resolve, reject) => {
				if (dead) {
					reject(dead);
					return;
				}
				const id = nextRequest++;
				pending.set(id, {
					resolve: (result) => {
						const error = (result as { error?: string } | null)?.error;
						if (error) reject(new Error(error));
						else resolve(result as T);
					},
					reject,
				});
				started?.(id);
				command({ type: "request", id, request: req });
			});
		// Running searches: id -> abort (rejects the caller's promise with an AbortError).
		const searches = new Map<number, () => void>();
		const aborted = () => new DOMException("Search aborted", "AbortError");
		const runSearch = <T>(req: Request, signal: AbortSignal | undefined, onProgress?: (r: SearchResults) => void) => {
			if (signal?.aborted) return Promise.reject(aborted());
			let id = 0;
			const abort = () => {
				const p = pending.get(id);
				if (!p) return;
				pending.delete(id);
				command({ type: "cancel", id });
				p.reject(aborted());
			};
			signal?.addEventListener("abort", abort, { once: true });
			// Settled by its answer, an abort (signal, cancelSearch, destroy) or a fatal
			// error; the cleanup runs before the caller resumes, so `isSearching` is false then.
			return request<T>(req, (i) => {
				id = i;
				searches.set(id, abort);
				if (onProgress) progressFns.set(id, onProgress);
			}).finally(() => {
				searches.delete(id);
				progressFns.delete(id);
				signal?.removeEventListener("abort", abort);
			});
		};

		if (wantTextLayer) {
			const layer = new TextLayer(container, (page) => request<TextLayerLine[]>({ type: "text-layer", page }));
			textLayer = layer;
			cleanups.push(() => layer.destroy());
		}
		opening.then(() => {
			if (!blob && !destroyed) command({ type: "remote", on: true });
		}, () => {});
		container.appendChild(overlay);
		cleanups.push(() => overlay.remove());
		const formLayer = new FormLayer(container, {
			send: (op) => command({ type: "form", op }),
			layout: () => layout,
			camera: () => camera,
			options: () => resolved,
		});
		forms = formLayer;
		cleanups.push(() => formLayer.destroy());

		// ------------------------------------------------------------ input
		let rect = container.getBoundingClientRect();
		const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
		const ac = new AbortController();
		cleanups.push(() => ac.abort());
		const on = <K extends keyof HTMLElementEventMap>(
			target: HTMLElement | Document | Window,
			type: K | string,
			fn: (e: any) => void,
			opts: AddEventListenerOptions = {},
		) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });

		const resize = () => {
			rect = container.getBoundingClientRect();
			send({ type: "resize", w: rect.width, h: rect.height, dpr: window.devicePixelRatio || 1 });
		};
		const ro = new ResizeObserver(resize);
		cleanups.push(() => ro.disconnect());
		ro.observe(container);
		resize();
		// Rect moves when an ancestor scrolls; DPR changes when the window moves screens.
		on(window, "scroll", () => (rect = container.getBoundingClientRect()), { capture: true, passive: true });
		let dprQuery: MediaQueryList | null = null;
		const watchDpr = () => {
			dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
			dprQuery.addEventListener(
				"change",
				() => {
					resize();
					watchDpr();
				},
				{ once: true, signal: ac.signal },
			);
		};
		watchDpr();
		motionQuery?.addEventListener("change", () => command({ type: "options", options: { reducedMotion: motionQuery.matches } }), { signal: ac.signal });

		on(
			container,
			"wheel",
			(e: WheelEvent) => {
				e.preventDefault();
				const p = local(e);
				send({ type: "wheel", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY, ctrl: e.ctrlKey, mode: e.deltaMode });
			},
			{ passive: false },
		);

		// Safari (macOS) delivers trackpad pinch as gesture events, not ctrl+wheel.
		let touchCount = 0;
		const gesture = (phase: "start" | "change" | "end") => (e: Event & { scale: number; clientX: number; clientY: number }) => {
			e.preventDefault();
			if (touchCount > 0) return; // iOS: pinch is handled from pointer events
			const p = local(e);
			send({ type: "gesture", phase, x: p.x, y: p.y, scale: e.scale });
		};
		on(container, "gesturestart", gesture("start"));
		on(container, "gesturechange", gesture("change"));
		on(container, "gestureend", gesture("end"));

		// Pointer events report detail 0 on down/up (per spec; some engines count),
		// so repeated presses are counted here: same pointer type, close in time and place.
		let press = { t: -Infinity, x: 0, y: 0, kind: "", clicks: 1 };
		/** a press that started on a form field: a tap or click there fills it in instead of selecting */
		let formPress: { id: number; x: number; y: number; t: number; hit: FormHit } | null = null;
		/** Routes form-field input; true when the event is consumed (the core never sees it). */
		const formPointer = (phase: "down" | "move" | "up" | "cancel", e: PointerEvent, kind: PointerKind) => {
			const p = local(e);
			if (phase === "down") {
				formPress = null;
				const hit = e.button === 0 && e.isPrimary ? formLayer.hit(p.x, p.y) : null;
				if (!hit) return false;
				formPress = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, hit };
				if (kind === "touch") return false;
				canvas.setPointerCapture(e.pointerId);
				return true;
			}
			const own = formPress?.id === e.pointerId ? formPress : null;
			if (phase === "move") {
				if (own && Math.hypot(e.clientX - own.x, e.clientY - own.y) > (kind === "touch" ? FORM_TAP_SLOP : MULTI_CLICK_PX)) formPress = null;
				if (kind === "touch") return false;
				if (own) return true;
				if (e.buttons) return false;
				const hover = formLayer.hit(p.x, p.y);
				if (hover) {
					if (!overWidget) send({ type: "leave" });
					overWidget = true;
					container.style.cursor = formLayer.cursor(hover);
					return true;
				}
				if (overWidget) {
					overWidget = false;
					container.style.cursor = coreCursor;
				}
				return false;
			}
			if (!own) return false;
			formPress = null;
			if (phase === "cancel") return kind !== "touch";
			if (kind === "touch") {
				if (touchCount > 0 || e.timeStamp - own.t > FORM_TAP_MS) return false;
				// The core saw the touch start: end it without its tap behaviour (links, clearing a selection).
				send({ type: "pointer", phase: "cancel", id: e.pointerId, x: p.x, y: p.y, buttons: 0, kind, clicks: 1, shift: false, primary: e.isPrimary });
			}
			formLayer.activate(own.hit, modifiers(e));
			return true;
		};
		const pointer = (phase: "down" | "move" | "up" | "cancel") => (e: PointerEvent) => {
			const kind = (e.pointerType || "mouse") as PointerKind;
			if (kind === "touch") {
				if (phase === "down") touchCount = e.isPrimary ? 1 : touchCount + 1;
				if (phase === "up" || phase === "cancel") touchCount = Math.max(0, touchCount - 1);
			}
			if (formLayer.active && formPointer(phase, e, kind)) return;
			if (phase === "down") {
				container.focus({ preventScroll: true });
				if (e.button === 0) {
					canvas.setPointerCapture(e.pointerId);
					const again = kind === press.kind && e.timeStamp - press.t < MULTI_CLICK_MS && Math.hypot(e.clientX - press.x, e.clientY - press.y) < MULTI_CLICK_PX;
					press = { t: e.timeStamp, x: e.clientX, y: e.clientY, kind, clicks: e.detail > 0 ? e.detail : again ? press.clicks + 1 : 1 };
				}
			}
			const p = local(e);
			send({ type: "pointer", phase, id: e.pointerId, x: p.x, y: p.y, buttons: e.buttons, kind, clicks: press.clicks, shift: e.shiftKey, primary: e.isPrimary });
		};
		on(canvas, "pointerdown", pointer("down"));
		on(canvas, "pointermove", pointer("move"));
		on(canvas, "pointerup", pointer("up"));
		on(canvas, "pointercancel", pointer("cancel"));
		on(canvas, "pointerleave", () => {
			if (overWidget) container.style.cursor = coreCursor;
			overWidget = false;
			send({ type: "leave" });
		});
		// A press on a field keeps focus where it is (an open field editor), instead of moving it to the container.
		on(canvas, "mousedown", (e: MouseEvent) => formPress && e.preventDefault());
		on(canvas, "touchstart", (e: TouchEvent) => e.preventDefault(), { passive: false });
		// Android fires contextmenu on long-press; the engine handles that as selection.
		on(canvas, "contextmenu", (e: Event) => touchCount > 0 && e.preventDefault());

		// The browser's find scrolls the (overflow: hidden) container to bring a
		// match in the hidden text layer into view: turn that into a camera pan.
		on(
			container,
			"scroll",
			() => {
				const dx = container.scrollLeft;
				const dy = container.scrollTop;
				if (!dx && !dy) return;
				container.scrollLeft = 0;
				container.scrollTop = 0;
				command({ type: "scroll-by", dx, dy });
			},
			{ passive: true },
		);

		if (interceptFind) {
			on(
				window,
				"keydown",
				(e: KeyboardEvent) => {
					if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "f") return;
					if (!container.contains(document.activeElement)) return;
					e.preventDefault();
					if (onEvent) host(() => onEvent({ type: "find" }));
				},
				{ capture: true },
			);
		}

		// Typing in a host input (in the overlay or elsewhere inside the container) is not viewer input.
		const editable = (t: EventTarget | null) => {
			const el = t instanceof Element ? t : null;
			if (!el || el === container) return false;
			if (el.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return true;
			return overlay.contains(el);
		};
		on(container, "keydown", (e: KeyboardEvent) => {
			if (editable(e.target)) return;
			const mod = e.metaKey || e.ctrlKey;
			const zoomKey = mod && ["=", "+", "-", "0"].includes(e.key);
			const selectAll = mod && !e.altKey && e.key.toLowerCase() === "a";
			if (!zoomKey && !selectAll && !NAV_KEYS.has(e.key)) return;
			e.preventDefault();
			send({ type: "key", key: e.key, mod, shift: e.shiftKey });
		});

		let copyEnabled = coreOptions.copyOptions !== false;
		on(document, "copy", (e: ClipboardEvent) => {
			if (!copyEnabled || !selectedText || !container.contains(document.activeElement) || editable(document.activeElement)) return;
			e.clipboardData?.setData("text/plain", selectedText);
			e.preventDefault();
		});

		return {
			canvas,
			get offscreen() {
				return offscreenNow;
			},
			get compositor() {
				return compositorNow;
			},
			zoomTo: (zoom) => command({ type: "zoom", zoom }),
			overlayElement: overlay,
			loaded,
			get options() {
				return { ...resolved };
			},
			get camera() {
				return { ...camera };
			},
			fitWidth: () => command({ type: "fit-width" }),
			fitPage: () => command({ type: "fit-page" }),
			goToPage: (page, top, o) => flight((id) => ({ type: "goto", page, top, animate: o?.animate, offset: o?.offset, flight: id })),
			reveal: (page, rect, o) =>
				flight((id) => ({ type: "reveal", page, rect, animate: o?.animate, align: o?.align, ifNeeded: o?.ifNeeded, offset: o?.offset, flight: id })),
			scrollState: () => {
				const last = layout[layout.length - 1];
				const docH = last ? last.y + last.h + resolved.pageGap : 0;
				const z = camera.zoom;
				const height = docH * z;
				const top = Math.max(0, Math.min(height - viewH, camera.y * z));
				const range = height - viewH;
				return { top, height, viewportHeight: viewH, fraction: range > 0 ? top / range : 0 };
			},
			scrollToFraction: (fraction) => command({ type: "scroll-to", fraction }),
			pulse: (ids, o) => command({ type: "pulse", ids: Array.isArray(ids) ? ids : [ids], kind: o?.kind, duration: o?.duration }),
			select: (page, from, to) => command({ type: "select", page, from, to }),
			setSelection: (range) => command({ type: "set-selection", range }),
			selectAll: (scope) => command({ type: "select-all", scope }),
			search: (query, limit, o) =>
				runSearch<SearchHit[]>(
					{ type: "search", query, limit, pages: o?.pages, matchDiacritics: o?.matchDiacritics, ignoreHyphenation: o?.ignoreHyphenation, fuzzy: o?.fuzzy },
					o?.signal,
				),
			searchAsync: (query, o = {}) => {
				const { signal, onProgress, ...opts } = o;
				return runSearch<SearchResults>({ type: "search-results", query, progress: !!onProgress, ...opts }, signal, onProgress);
			},
			cancelSearch: () => {
				for (const abort of [...searches.values()]) abort();
			},
			get isSearching() {
				return searches.size > 0;
			},
			outline: () => request<OutlineItem[]>({ type: "outline" }),
			annotations: async (page) => {
				await loaded;
				return request<PdfAnnotation[]>({ type: "annotations", page });
			},
			pageFigures: async (page) => {
				await loaded;
				return request<PageFigure[]>({ type: "figures", page });
			},
			pageText: (page) => request<string>({ type: "page-text", page }),
			pageTextMap: (page) => request<{ text: string; chars: Int32Array }>({ type: "page-text-map", page }),
			rects: (page, from, to) => request<Rect[]>({ type: "rects", page, from, to }),
			getData: async () => new Uint8Array(await (await fetchAll()).arrayBuffer()),
			saveDocument: () => {
				formLayer.commit();
				return request<Uint8Array>({ type: "save-document" });
			},
			thumbnail: async (page, width) => {
				const res = await request<{ buf: ArrayBuffer; w: number; h: number } | null>({ type: "thumbnail", page, width });
				if (!res) return null;
				return createImageBitmap(new ImageData(new Uint8ClampedArray(res.buf), res.w, res.h));
			},
			setHighlights: (items) => command({ type: "highlights", items }),
			clearSelection: () => command({ type: "clear-selection" }),
			setOptions: (o) => {
				if ("copyOptions" in o) copyEnabled = o.copyOptions !== false;
				resolved = { ...resolved, ...o };
				command({ type: "options", options: o });
			},
			unlock: (password) =>
				opened || dead
					? Promise.resolve(opened)
					: new Promise<boolean>((resolve) => {
							unlocks.push(resolve);
							latestPassword = password;
							command({ type: "unlock", password });
						}),
			get selectedText() {
				return selectedText;
			},
			destroy() {
				if (destroyed) return;
				// Searches end as cancelled; everything else as destroyed.
				for (const abort of [...searches.values()]) abort();
				teardown(new EngineError("lector-engine: the viewer was destroyed", "destroyed", "request"));
			},
		};
	}
}
