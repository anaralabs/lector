// Persistent cache of base page bitmaps (IndexedDB, compressed), so a document
// opened again shows its pages without waiting for PDFium. Works on the main
// thread and in workers. Every failure (private mode, quota, blocked storage)
// turns the cache off for the session; the viewer renders as if it were absent.

const DB = "lector-engine-tiles";
/** bumped when rendering changes (PDFium, render flags): older bitmaps are never read */
const RENDER_VERSION = 2;
const STORE = "tiles";

interface Entry {
	doc: string;
	blob: Blob;
	w: number;
	h: number;
	size: number;
	at: number;
}

const req = <T>(r: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});

const done = (tx: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("aborted"));
	});

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb() {
	dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => {
			const store = r.result.createObjectStore(STORE);
			store.createIndex("at", "at");
		};
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
		r.onblocked = () => reject(new Error("blocked"));
	}).catch((err) => {
		dbPromise = null;
		throw err;
	});
	return dbPromise;
}

/** Whether this context can encode, store and decode cached bitmaps. */
export function tileCacheSupported() {
	return typeof indexedDB !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function" && typeof OffscreenCanvas.prototype.convertToBlob === "function";
}

let encodeType: string | null = null;
async function encode(pixels: Uint8Array, w: number, h: number): Promise<Blob> {
	const canvas = new OffscreenCanvas(w, h);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, w * h * 4), w, h), 0, 0);
	// WebP where the browser encodes it (Safari falls back to PNG: use JPEG there, pages are opaque).
	if (encodeType !== "image/jpeg") {
		const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
		encodeType = blob.type;
		if (blob.type === "image/webp") return blob;
		encodeType = "image/jpeg";
	}
	return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

export class TileCache {
	private db: IDBDatabase | null = null;
	/** `page|scale|w|h` of every bitmap stored for this document */
	private keys = new Set<string>();
	private writing = new Set<string>();
	private queue: { id: string; page: number; pixels: Uint8Array; w: number; h: number }[] = [];
	private busy = false;
	private off = false;
	readonly ready: Promise<void>;

	private doc: string;
	private budgetBytes: number;
	private maxQueued: number;

	constructor(doc: string, budgetBytes: number, maxQueued = 4) {
		this.maxQueued = maxQueued;
		this.doc = `v${RENDER_VERSION}:${doc}`;
		this.budgetBytes = budgetBytes;
		this.ready = this.init().catch(() => this.disable());
	}

	private async init() {
		if (!tileCacheSupported()) throw new Error("unsupported");
		const db = await openDb();
		const prefix = `${this.doc}|`;
		const keys = await req(db.transaction(STORE).objectStore(STORE).getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
		for (const k of keys) this.keys.add(String(k).slice(prefix.length));
		this.db = db;
	}

	private disable() {
		this.off = true;
		this.db = null;
		this.keys.clear();
		this.queue = [];
	}

	get enabled() {
		return !this.off && this.db !== null;
	}

	has(page: number, scale: number, w: number, h: number) {
		return this.enabled && this.keys.has(`${page}|${scale}|${w}|${h}`);
	}

	/** The stored bitmap, or null (missing, evicted meanwhile, or storage failed: then it renders as usual). */
	async get(page: number, scale: number, w: number, h: number): Promise<ImageBitmap | null> {
		const db = this.db;
		if (!db || this.off) return null;
		const key = `${page}|${scale}|${w}|${h}`;
		const id = `${this.doc}|${key}`;
		try {
			const entry = await req<Entry | undefined>(db.transaction(STORE).objectStore(STORE).get(id));
			const bitmap = entry && (await createImageBitmap(entry.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }));
			if (!entry || !bitmap || bitmap.width !== entry.w || bitmap.height !== entry.h) {
				bitmap?.close();
				this.keys.delete(key);
				return null;
			}
			// LRU order only needs to be rough: refresh an entry's time at most hourly (a put rewrites the blob).
			if (Date.now() - entry.at > 3600_000) {
				const tx = db.transaction(STORE, "readwrite");
				tx.objectStore(STORE).put({ ...entry, at: Date.now() }, id);
				done(tx).catch(() => {});
			}
			return bitmap;
		} catch {
			this.keys.delete(key);
			return null;
		}
	}

	/** page in view: queued bitmaps nearest to it are written first and dropped last */
	focus = 0;

	/** Queues a base bitmap for `writeNext` (a few wait; the farthest from `focus` are dropped). `pixels` must not be reused by the caller. */
	put(page: number, scale: number, pixels: Uint8Array, w: number, h: number) {
		const key = `${page}|${scale}|${w}|${h}`;
		// queued while the database opens too; `disable` drops the queue if it never does
		if (this.off || this.keys.has(key) || this.writing.has(key)) return;
		this.writing.add(key);
		this.queue.push({ id: key, page, pixels, w, h });
		while (this.queue.length > this.maxQueued) this.writing.delete(this.queue.splice(this.pick(Math.max), 1)[0]!.id);
	}

	/** Index of the queued bitmap nearest to (Math.min) or farthest from (Math.max) the focus; the first pages count as near (a document without a saved position reopens there). */
	private pick(best: (...xs: number[]) => number) {
		const dist = (q: { page: number }) => (q.page < 2 ? 0 : Math.abs(q.page - this.focus));
		const target = best(...this.queue.map(dist));
		return this.queue.findIndex((q) => dist(q) === target);
	}

	/** bitmaps are waiting for `writeNext` */
	get queued() {
		return this.enabled && this.queue.length > 0 && !this.busy;
	}

	/** Encodes and stores one queued bitmap; the owner calls it when idle (encoding costs a few ms of this thread). */
	async writeNext() {
		if (this.busy || !this.enabled) return;
		if (!this.queue.length) return;
		const job = this.queue.splice(this.pick(Math.min), 1)[0]!;
		this.busy = true;
		try {
			await this.write(job.id, await encode(job.pixels, job.w, job.h), job.w, job.h);
		} catch (err) {
			// Quota or storage failure: stop caching rather than retrying every page.
			if ((err as Error)?.name !== "EncodingError") this.disable();
		} finally {
			this.writing.delete(job.id);
			this.busy = false;
		}
	}

	private async write(key: string, blob: Blob, w: number, h: number) {
		const db = this.db;
		if (!db) return;
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put({ doc: this.doc, blob, w, h, size: blob.size, at: Date.now() } satisfies Entry, `${this.doc}|${key}`);
		await done(tx);
		this.keys.add(key);
		await this.evict(db);
	}

	/** Deletes the least recently used bitmaps (any document) until the store fits 85% of the budget. */
	private evict(db: IDBDatabase) {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		const rows: { key: IDBValidKey; size: number }[] = [];
		let total = 0;
		const cursor = store.index("at").openCursor();
		cursor.onsuccess = () => {
			const c = cursor.result;
			if (c) {
				const size = (c.value as Entry).size;
				rows.push({ key: c.primaryKey, size });
				total += size;
				c.continue();
				return;
			}
			// Still inside the request callback, so the transaction is active for the deletes.
			if (total <= this.budgetBytes) return;
			const prefix = `${this.doc}|`;
			for (const row of rows) {
				if (total <= this.budgetBytes * 0.85) break;
				store.delete(row.key);
				total -= row.size;
				const k = String(row.key);
				if (k.startsWith(prefix)) this.keys.delete(k.slice(prefix.length));
			}
		};
		return done(tx);
	}
}

/**
 * A key for documents given as bytes: SHA-256 of the length and the first and
 * last 256KB (an incremental save rewrites the tail). Null without WebCrypto.
 */
export async function documentKey(blob: Blob): Promise<string | null> {
	try {
		if (typeof crypto === "undefined" || !crypto.subtle) return null;
		const span = 256 * 1024;
		const head = new Uint8Array(await blob.slice(0, span).arrayBuffer());
		const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - span)).arrayBuffer());
		const len = new TextEncoder().encode(`${blob.size}:`);
		const all = new Uint8Array(len.length + head.length + tail.length);
		all.set(len);
		all.set(head, len.length);
		all.set(tail, len.length + head.length);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
		return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
	} catch {
		return null;
	}
}
