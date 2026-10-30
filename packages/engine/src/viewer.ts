// Main-thread shell: owns the <canvas>, spawns workers, forwards input and
// mirrors the little state the DOM needs (cursor, copied text).

import {
	type Command,
	type CoreEvent,
	type Camera,
	type CoreOptions,
	defaultOptions,
	type InputMsg,
	type PointerKind,
	type PulseKind,
	type Request,
	type RevealAlign,
	type SearchHit,
	type SearchResults,
	ViewerCore,
} from "./core";
import type { SearchOptions } from "./search";
import { EngineError } from "./errors";
import type { DocSource, DocumentInfo, OutlineItem, PageSize } from "./protocol";
import { getEngineSupport } from "./support";
import type { Rect, TextPoint } from "./text";
import { TextLayer, type TextLayerLine } from "./text-layer";

export interface ViewerOptions extends Partial<CoreOptions> {
	/** URL of pdfium.wasm (from `@embedpdf/pdfium/pdfium.wasm`) */
	wasmUrl: string;
	/** number of PDFium raster workers (default: half the cores, 2-4) */
	workers?: number;
	/** run the compositor in a worker with an OffscreenCanvas (default: when WebGL2 works on one) */
	offscreen?: boolean;
	onEvent?: (e: CoreEvent) => void;
	/**
	 * Creates the engine's module workers. Override to wrap them (e.g. a blob
	 * loader that dynamic-imports `url`, which survives extensions that re-wrap
	 * module workers). The engine waits for each worker's `boot` message.
	 */
	createWorker?: (url: URL, name: string) => Worker;
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
	 * interrupted it. `top`: page points below the page top; `offset`: css px
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
	pageText(page: number): Promise<string>;
	/** page text plus `chars[i]`: the char index (for `rects`) of UTF-16 unit `i` */
	pageTextMap(page: number): Promise<{ text: string; chars: Int32Array }>;
	/** rects (page points, one per line) of chars [from, to) on a page */
	rects(page: number, from: number, to: number): Promise<Rect[]>;
	/** a rendered page at `width` device pixels, for thumbnails */
	thumbnail(page: number, width: number): Promise<ImageBitmap | null>;
	/** a copy of the document bytes */
	getData(): Promise<Uint8Array>;
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

/**
 * Probe for range support with a 1KB request. A 206 with a total length means
 * range loading works; a 200 means the server sent the whole file, which is
 * then used as is (nothing is downloaded twice).
 */
async function openUrl(url: string, range: boolean): Promise<{ blob: Blob } | { length: number }> {
	if (!range) return { blob: await (await fetchPdf(url)).blob() };
	const res = await fetchPdf(url, { headers: { Range: "bytes=0-1023" } });
	const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("Content-Range") ?? "")?.[1]);
	const encoded = (res.headers.get("Content-Encoding") ?? "identity") !== "identity";
	if (res.status === 206 && total > 0 && !encoded) {
		void res.body?.cancel();
		return { length: total };
	}
	if (res.status === 206) return { blob: await (await fetchPdf(url)).blob() };
	return { blob: await res.blob() };
}

/** presses closer than this (ms, css px) count as a double/triple click */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 6;

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", " ", "Escape"]);

export async function createViewer(container: HTMLElement, source: string | ArrayBuffer | Uint8Array, options: ViewerOptions): Promise<Viewer> {
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
		...coreOptions
	} = options;
	// Workers may run from blob: URLs (host loaders), where relative URLs don't resolve.
	const wasmUrl = new URL(wasmUrlOption, location.href).href;
	// One Blob shared by every raster worker (posting a Blob does not copy it);
	// workers read blocks from it on demand. Range loading starts from the URL.
	let blob: Blob | null = null;
	let docSource: DocSource;
	if (typeof source === "string") {
		const absolute = new URL(source, location.href).href;
		const opened = await openUrl(absolute, rangeLoading);
		if ("blob" in opened) blob = opened.blob;
		docSource = blob ? { kind: "blob", blob } : { kind: "url", url: absolute, length: (opened as { length: number }).length, credentials: new URL(absolute).origin === location.origin };
	} else {
		blob = new Blob([(source instanceof Uint8Array ? source : new Uint8Array(source)) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
		docSource = { kind: "blob", blob };
	}
	// Everything acquired from here on is released in reverse order by `destroy`,
	// or right away if construction fails part-way (the caller gets no viewer).
	const cleanups: (() => void)[] = [];
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
	try {
		return build();
	} catch (err) {
		destroyed = true;
		release();
		throw err;
	}

	function build(): Viewer {
		const spawn = (kind: "raster" | "core", name: string) => {
			const url = workerUrls?.[kind];
			// Literal `new Worker(new URL(...))` so bundlers emit the worker chunks.
			const worker = url
				? createWorker
					? createWorker(new URL(url, location.href), name)
					: new Worker(url, { type: "module", name })
				: kind === "raster"
					? new Worker(new URL("./raster-worker.ts", import.meta.url), { type: "module", name })
					: new Worker(new URL("./core-worker.ts", import.meta.url), { type: "module", name });
			const booted = new Promise<void>((resolve) => {
				const onBoot = (ev: MessageEvent) => {
					if ((ev.data as { t?: string } | null)?.t !== "boot") return;
					worker.removeEventListener("message", onBoot);
					resolve();
				};
				worker.addEventListener("message", onBoot);
			});
			// A worker script that fails to load never boots; say so instead of hanging.
			worker.addEventListener("error", (ev) => {
				// Async (after setup), so handleEvent exists; it also rejects `loaded`.
				handleEvent({ type: "error", message: `lector-engine: ${name} worker failed${ev.message ? `: ${ev.message}` : " to load"}`, code: "worker", phase: "engine-load" });
			});
			return { worker, booted };
		};
		let fullFetch: Promise<Blob> | null = null;
		const fetchAll = () => {
			if (blob) return Promise.resolve(blob);
			fullFetch ??= fetchPdf((docSource as { url: string }).url)
				.then((res) => res.blob())
				.then((b) => {
					blob = b;
					for (const w of rasterWorkers) w.postMessage({ t: "source", blob: b });
					return b;
				});
			return fullFetch;
		};

		const canvas = document.createElement("canvas");
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
		const overlay = document.createElement("div");
		overlay.className = "lector-overlay";
		overlay.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2;";

		// Raster workers, each with a port to the core. They share the document
		// source. Phones and tablets: each worker still holds PDFium's heap, and iOS
		// kills tabs that hold a few hundred MB, so use fewer of everything.
		const touchDevice = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
		// Camera flights jump instantly for people who asked for less motion.
		const motionQuery = coreOptions.reducedMotion === undefined && typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
		if (motionQuery) coreOptions.reducedMotion = motionQuery.matches;
		if (touchDevice) coreOptions.textureBudgetMB ??= 128;
		const n = workerCount ?? (touchDevice ? 2 : Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
		const rasterWorkers: Worker[] = [];
		const corePorts: MessagePort[] = [];
		cleanups.push(() => {
			for (const w of rasterWorkers) w.terminate();
			for (const port of corePorts) port.close();
		});
		for (let i = 0; i < n; i++) {
			const { worker, booted } = spawn("raster", `lector-raster-${i}`);
			rasterWorkers.push(worker);
			const channel = new MessageChannel();
			corePorts.push(channel.port2);
			booted.then(() => {
				if (!destroyed) worker.postMessage({ t: "init", source: docSource, port: channel.port1, wasmUrl, password, sizes: i === 0 }, [channel.port1]);
			});
		}

		let selectedText = "";
		let opened = false;
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
			for (const [id, p] of [...pending]) {
				pending.delete(id);
				p.reject(err);
			}
		};
		const progressFns = new Map<number, (r: SearchResults) => void>();
		const flights = new Map<number, (landed: boolean) => void>();
		const handleEvent = (e: CoreEvent) => {
			if (e.type === "resized") {
				canvas.style.width = `${e.w}px`;
				canvas.style.height = `${e.h}px`;
				textLayer?.setViewport(e.w, e.h);
				viewH = e.h;
			} else if (e.type === "camera") {
				camera = e.camera;
				textLayer?.setCamera(e.camera);
			}
			else if (e.type === "cursor") container.style.cursor = e.cursor;
			else if (e.type === "selection") {
				if (e.final) selectedText = e.selection?.text ?? "";
			} else if (e.type === "link") {
				if (onLink) onLink(e.url);
				else if (/^(https?|mailto):/i.test(e.url)) window.open(e.url, "_blank", "noopener,noreferrer");
			} else if (e.type === "flight") {
				flights.get(e.id)?.(e.landed);
				flights.delete(e.id);
			} else if (e.type === "painted") {
				// Range loading: the first page is up; now fetch the rest in the background.
				if (autoFetch && !blob) void fetchAll().catch(() => {});
			} else if (e.type === "ready") {
				opened = true;
				layout = e.layout;
				resolveLoaded({ pages: e.pages, info: e.info });
				textLayer?.setLayout(e.layout);
				for (const resolve of unlocks.splice(0)) resolve(true);
			} else if (e.type === "error" && e.code === "password" && e.phase === "document-load") {
				for (const resolve of unlocks.splice(0)) resolve(false);
			} else if (e.type === "error" && (e.phase === "document-load" || e.phase === "engine-load") && !opened) {
				// Fatal: nothing will answer requests (a worker that did not load, a document that cannot open).
				fail(new EngineError(e.message, e.code, e.phase, typeof source === "string" ? source : undefined));
			} else if (e.type === "search-progress") progressFns.get(e.id)?.(e.results);
			else if (e.type === "response") {
				const p = pending.get(e.id);
				pending.delete(e.id);
				p?.resolve(e.result);
				return;
			}
			onEvent?.(e);
		};

		// Probed, not just feature-tested: Safari 16.4-16.x can transfer a canvas
		// but has no WebGL on OffscreenCanvas, so it composites on the main thread.
		const useOffscreen = (wantOffscreen ?? true) && support.offscreen;
		let coreWorker: Worker | null = null;
		let postToCore: (msg: unknown) => void = () => {};
		let core: ViewerCore | null = null;
		const debug = !!(globalThis as { __lectorEngineDebug?: boolean }).__lectorEngineDebug;
		if (useOffscreen) {
			const offscreen = canvas.transferControlToOffscreen();
			const spawned = spawn("core", "lector-compositor");
			coreWorker = spawned.worker;
			const worker = coreWorker;
			cleanups.push(() => {
				// The worker disposes its core (GPU resources, ports, timers) and closes itself.
				worker.postMessage({ t: "dispose" });
				setTimeout(() => worker.terminate(), 1000);
			});
			coreWorker.onmessage = (ev: MessageEvent<CoreEvent | { t: "boot" }>) => {
				if ("type" in ev.data) handleEvent(ev.data);
			};
			// Input posted before boot queues inside the worker until init arrives.
			const pendingInput: unknown[] = [];
			postToCore = (msg) => pendingInput.push(msg);
			spawned.booted.then(() => {
				if (destroyed) return;
				worker.postMessage({ t: "init", canvas: offscreen, ports: corePorts, options: coreOptions, debug }, [offscreen, ...corePorts]);
				for (const msg of pendingInput) worker.postMessage(msg);
				postToCore = (msg) => worker.postMessage(msg);
			});
		} else {
			try {
				core = new ViewerCore(canvas, corePorts, handleEvent, (cb) => requestAnimationFrame(cb), coreOptions);
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
		}

		const send = (msg: InputMsg) => {
			if (core) core.handle(msg);
			else postToCore({ t: "input", msg });
		};
		const command = (cmd: Command) => {
			if (core) core.command(cmd);
			else postToCore({ t: "command", cmd });
		};
		let nextFlight = 1;
		const flight = (make: (id: number) => Command) =>
			new Promise<boolean>((resolve) => {
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
		container.appendChild(overlay);
		cleanups.push(() => overlay.remove());

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
		const pointer = (phase: "down" | "move" | "up" | "cancel") => (e: PointerEvent) => {
			const kind = (e.pointerType || "mouse") as PointerKind;
			if (kind === "touch") {
				if (phase === "down") touchCount++;
				if (phase === "up" || phase === "cancel") touchCount = Math.max(0, touchCount - 1);
			}
			if (phase === "down") {
				container.focus({ preventScroll: true });
				if (e.button === 0) {
					canvas.setPointerCapture(e.pointerId);
					const again = kind === press.kind && e.timeStamp - press.t < MULTI_CLICK_MS && Math.hypot(e.clientX - press.x, e.clientY - press.y) < MULTI_CLICK_PX;
					press = { t: e.timeStamp, x: e.clientX, y: e.clientY, kind, clicks: e.detail > 0 ? e.detail : again ? press.clicks + 1 : 1 };
				}
			}
			const p = local(e);
			send({ type: "pointer", phase, id: e.pointerId, x: p.x, y: p.y, buttons: e.buttons, kind, clicks: press.clicks, shift: e.shiftKey });
		};
		on(canvas, "pointerdown", pointer("down"));
		on(canvas, "pointermove", pointer("move"));
		on(canvas, "pointerup", pointer("up"));
		on(canvas, "pointercancel", pointer("cancel"));
		on(canvas, "pointerleave", () => send({ type: "leave" }));
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
					onEvent?.({ type: "find" });
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
			offscreen: useOffscreen,
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
			pageText: (page) => request<string>({ type: "page-text", page }),
			pageTextMap: (page) => request<{ text: string; chars: Int32Array }>({ type: "page-text-map", page }),
			rects: (page, from, to) => request<Rect[]>({ type: "rects", page, from, to }),
			getData: async () => new Uint8Array(await (await fetchAll()).arrayBuffer()),
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
				opened
					? Promise.resolve(true)
					: new Promise<boolean>((resolve) => {
							unlocks.push(resolve);
							command({ type: "unlock", password });
						}),
			get selectedText() {
				return selectedText;
			},
			destroy() {
				if (destroyed) return;
				destroyed = true;
				for (const resolve of flights.values()) resolve(false);
				flights.clear();
				for (const abort of [...searches.values()]) abort();
				fail(new EngineError("lector-engine: the viewer was destroyed", "destroyed", "request"));
				release();
				core = null;
				postToCore = () => {};
			},
		};
	}
}
