// Headless rendering: one page region to an ImageBitmap, without a viewer,
// canvas or WebGL. Each open document is one raster worker reading the file
// through range requests; the compiled pdfium.wasm is shared with viewers.

import { EngineError } from "./errors";
import type { DocSource, ErrorCode, ErrorPhase, FromRaster, PageSize, ToRaster } from "./protocol";
import { RANGE_GRANULE } from "./range";
import { type Region, regionRaster } from "./region";
import { getEngineSupport } from "./support";
import { openUrl, preloadPdfium } from "./viewer";
import { type CreateWorker, retryUrl, startWorker, type WorkerType } from "./worker-start";

export type { Region } from "./region";

export interface PageRendererOptions {
	/** URL of pdfium.wasm, as for `createViewer` */
	wasmUrl: string;
	/** URL of the raster worker script (`workerUrls.raster`); defaults to the bundled one */
	workerUrl?: string;
	/** builds the worker for `workerUrl`, as for `createViewer` (cross-origin hosts) */
	createWorker?: CreateWorker;
	/** documents kept open at once; each holds a worker with its own PDFium heap (default 2) */
	maxDocuments?: number;
	/** a document nothing has asked for in this long is closed (ms, default 30s) */
	idleMs?: number;
}

export interface RenderRequest {
	/** 0-based page */
	page: number;
	/** the part of the page to render in points (top-left origin), or a function of the page's size; the whole page when omitted */
	region?: Region | ((page: PageSize) => Region);
	/** output width in device pixels (the height follows the region's aspect) */
	width: number;
	/** names the document across renders (e.g. a document id for rotating signed URLs); defaults to the URL */
	key?: string;
	password?: string;
	/** stops waiting; a render already running in the worker is cancelled */
	signal?: AbortSignal;
}

export interface RenderedRegion {
	bitmap: ImageBitmap;
	/** the page's size in points */
	page: PageSize;
	pageCount: number;
	/** the region rendered, clamped to the page, in points */
	rect: Region;
	/** device pixels per point */
	scale: number;
	/** from the request to the bitmap */
	ms: number;
}

export interface PageRenderer {
	render(source: string | Blob | ArrayBuffer | Uint8Array, request: RenderRequest): Promise<RenderedRegion>;
	/** closes one document now (its pending renders reject) */
	close(key: string): void;
	/** closes every document; later renders reject */
	destroy(): void;
}

type Answer = Extract<FromRaster, { t: "tile" } | { t: "sizes" } | { t: "cancelled" }>;

interface Waiter {
	resolve: (res: Answer) => void;
	reject: (err: unknown) => void;
}

interface Doc {
	key: string;
	worker: Worker | null;
	port: MessagePort | null;
	opened: Promise<void>;
	/** settles `opened` when the document closes before it opened */
	abandon: (err: unknown) => void;
	pageCount: number;
	sizes: Map<number, PageSize>;
	waiters: Map<number, Waiter>;
	network: AbortController;
	pending: number;
	idle: ReturnType<typeof setTimeout> | undefined;
	closed: boolean;
}

const abortError = () => new DOMException("The render was aborted.", "AbortError");

export function createPageRenderer(options: PageRendererOptions): PageRenderer {
	const { wasmUrl: wasmUrlOption, workerUrl, createWorker, maxDocuments = 2, idleMs = 30_000 } = options;
	const wasmUrl = new URL(wasmUrlOption, location.href).href;
	const docs = new Map<string, Doc>();
	let nextId = 1;
	let destroyed = false;

	const type: WorkerType = getEngineSupport().moduleWorkers ? "module" : "classic";
	const spawn = (name: string, attempt: number): Worker => {
		if (!workerUrl)
			return type === "module"
				? new Worker(new URL("./raster-worker.ts", import.meta.url), { type: "module", name })
				: new Worker(new URL("./raster-worker.ts", import.meta.url), { name });
		const url = retryUrl(new URL(workerUrl, location.href), attempt);
		return createWorker ? createWorker(url, name, { type }) : new Worker(url, { type, name });
	};

	const close = (doc: Doc, err: unknown = new EngineError("lector-engine: the document was closed", "destroyed", "request")) => {
		if (doc.closed) return;
		doc.closed = true;
		if (docs.get(doc.key) === doc) docs.delete(doc.key);
		if (doc.idle) clearTimeout(doc.idle);
		doc.abandon(err);
		doc.network.abort();
		if (doc.port) {
			doc.port.onmessage = null;
			doc.port.close();
		}
		doc.worker?.terminate();
		for (const w of doc.waiters.values()) w.reject(err);
		doc.waiters.clear();
	};

	const open = (key: string, source: string | Blob | ArrayBuffer | Uint8Array, page: number, password?: string): Doc => {
		const network = new AbortController();
		const doc: Doc = {
			key,
			worker: null,
			port: null,
			opened: Promise.resolve(),
			abandon: () => {},
			pageCount: 0,
			sizes: new Map(),
			waiters: new Map(),
			network,
			pending: 0,
			idle: undefined,
			closed: false,
		};
		const pdfium = preloadPdfium(wasmUrl);
		const docSource: Promise<DocSource> =
			typeof source === "string"
				? openUrl(new URL(source, location.href).href, true, page === 0, page, network.signal, { requests: 0, firstByteAt: 0, bytes: 0 }).then((opened) => {
						if ("blob" in opened) return { kind: "blob", blob: opened.blob };
						const give = (start: number, bytes: Uint8Array) => {
							const data = bytes.slice();
							doc.worker?.postMessage({ t: "block", start, data } satisfies ToRaster, [data.buffer]);
						};
						// A region needs a few blocks: a racing whole download stops, keeping what already arrived.
						const stream = opened.stream;
						if (stream) {
							const upTo = Math.floor(stream.received / RANGE_GRANULE) * RANGE_GRANULE;
							if (upTo > stream.seeded) give(stream.seeded, stream.buf.subarray(stream.seeded, upTo));
							stream.stop();
						}
						void opened.late?.then((seeds) => {
							if (!doc.closed) for (const [start, bytes] of seeds) give(start, bytes);
						});
						const url = new URL(source, location.href);
						return { kind: "url", url: url.href, length: opened.length, credentials: url.origin === location.origin, seeds: opened.seeds };
					})
				: Promise.resolve({ kind: "blob", blob: source instanceof Blob ? source : new Blob([(source instanceof Uint8Array ? source : new Uint8Array(source)) as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) });
		const name = `lector-render-${key.slice(-24)}`;
		doc.opened = new Promise<void>((resolve, reject) => {
			doc.abandon = reject;
			const fail = (message: string, code: ErrorCode, phase: ErrorPhase) => {
				const err = new EngineError(message, code, phase, typeof source === "string" ? source : undefined);
				reject(err);
				close(doc, err);
			};
			const workerFailed = (ev: ErrorEvent) => fail(`lector-engine: render worker failed${ev.message ? `: ${ev.message}` : " to load"}`, "worker", "engine-load");
			const { booted } = startWorker({
				create: (attempt) => (doc.worker = spawn(name, attempt)),
				stopped: () => doc.closed,
				onLoadFailed: workerFailed,
				onCrashed: workerFailed,
			});
			Promise.all([docSource, booted, pdfium]).then(([src, worker, module]) => {
				if (doc.closed) return;
				const channel = new MessageChannel();
				doc.port = channel.port2;
				channel.port2.onmessage = (ev: MessageEvent<FromRaster>) => {
					const msg = ev.data;
					if (msg.t === "opened") {
						doc.pageCount = msg.pageCount;
						for (const [p, w, h] of msg.sizes) doc.sizes.set(p, { w, h });
						resolve();
						return;
					}
					if (msg.t === "error" && msg.id === undefined) {
						fail(msg.message, msg.code, msg.phase);
						return;
					}
					if (!("id" in msg) || msg.id === undefined) return;
					const waiter = doc.waiters.get(msg.id);
					if (!waiter) return;
					doc.waiters.delete(msg.id);
					if (msg.t === "error") waiter.reject(new EngineError(msg.message, msg.code, msg.phase));
					else if (msg.t === "tile" || msg.t === "sizes" || msg.t === "cancelled") waiter.resolve(msg);
				};
				const init: ToRaster = { t: "init", source: src, port: channel.port1, wasmUrl, password, sizes: { all: false, pages: [page] } };
				try {
					worker.postMessage(module ? { ...init, module } : init, [channel.port1]);
				} catch {
					worker.postMessage(init, [channel.port1]);
				}
			}, (err) => {
				if (doc.closed) return;
				const e = err instanceof EngineError ? err : new EngineError(String((err as Error)?.message ?? err), "fetch", "document-load");
				reject(e);
				close(doc, e);
			});
		});
		doc.opened.catch(() => {});
		return doc;
	};

	const ask = (doc: Doc, msg: ToRaster & { id: number }, signal?: AbortSignal) =>
		new Promise<Answer>((resolve, reject) => {
			if (signal?.aborted) return reject(abortError());
			const onAbort = () => {
				if (!doc.waiters.delete(msg.id)) return;
				if (msg.t === "tile") doc.port?.postMessage({ t: "cancel", id: msg.id } satisfies ToRaster);
				reject(abortError());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const done = <T>(fn: (v: T) => void) => (v: T) => {
				signal?.removeEventListener("abort", onAbort);
				fn(v);
			};
			doc.waiters.set(msg.id, { resolve: done(resolve), reject: done(reject) });
			doc.port!.postMessage(msg);
		});

	const pageSize = async (doc: Doc, page: number, signal?: AbortSignal): Promise<PageSize> => {
		const known = doc.sizes.get(page);
		if (known) return known;
		const res = await ask(doc, { t: "sizes", id: nextId++, page, pages: [page] }, signal);
		if (res.t === "sizes") for (const [p, w, h] of res.sizes) doc.sizes.set(p, { w, h });
		const size = doc.sizes.get(page);
		if (!size) throw new EngineError(`lector-engine: no size for page ${page}`, "unknown", "request");
		return size;
	};

	const acquire = (key: string, source: string | Blob | ArrayBuffer | Uint8Array, page: number, password?: string) => {
		let doc = docs.get(key);
		if (doc) docs.delete(key);
		else doc = open(key, source, page, password);
		docs.set(key, doc);
		for (const other of docs.values()) {
			if (docs.size <= Math.max(1, maxDocuments)) break;
			if (other !== doc) close(other);
		}
		if (doc.idle) clearTimeout(doc.idle);
		doc.idle = undefined;
		doc.pending++;
		return doc;
	};

	const release = (doc: Doc) => {
		doc.pending--;
		if (doc.pending > 0 || doc.closed) return;
		doc.idle = setTimeout(() => close(doc), idleMs);
	};

	return {
		async render(source, request) {
			const t0 = performance.now();
			if (destroyed) throw new EngineError("lector-engine: the renderer was destroyed", "destroyed", "request");
			const { page, region, width, password, signal } = request;
			if (signal?.aborted) throw abortError();
			const key = request.key ?? (typeof source === "string" ? source : `bytes:${nextId++}`);
			const doc = acquire(key, source, page, password);
			try {
				await doc.opened;
				if (signal?.aborted) throw abortError();
				if (!Number.isInteger(page) || page < 0 || page >= doc.pageCount) throw new RangeError(`lector-engine: page ${page} is outside the document (${doc.pageCount} pages)`);
				const size = await pageSize(doc, page, signal);
				const box = regionRaster(size, typeof region === "function" ? region(size) : region, width);
				if (!box) throw new RangeError("lector-engine: the region is empty");
				const res = await ask(doc, { t: "tile", id: nextId++, page, scale: box.scale, x: box.x, y: box.y, w: box.w, h: box.h }, signal);
				if (res.t !== "tile") throw abortError();
				const bitmap = res.bitmap ?? (res.buf ? await createImageBitmap(new ImageData(new Uint8ClampedArray(res.buf), res.w, res.h)) : null);
				if (!bitmap) throw new EngineError("lector-engine: the render returned no pixels", "unknown", "render");
				return { bitmap, page: size, pageCount: doc.pageCount, rect: box.rect, scale: box.scale, ms: performance.now() - t0 };
			} finally {
				release(doc);
			}
		},
		close(key) {
			const doc = docs.get(key);
			if (doc) close(doc);
		},
		destroy() {
			destroyed = true;
			for (const doc of [...docs.values()]) close(doc);
		},
	};
}
