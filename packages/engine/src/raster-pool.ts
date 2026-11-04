// Schedules tile and text jobs across independent PDFium workers.
// The core re-plans every frame: jobs that are no longer wanted are dropped
// before dispatch, and the most urgent jobs go out first. Each job goes to the
// worker expected to finish it soonest: a worker that already has the page
// loaded skips the parse and image decode, which dominate scanned pages.

import type { FormOp } from "./forms";
import type { DocumentInfo, ErrorCode, ErrorPhase, FromRaster, LoadFailureDetail, OpenTiming, SizeEntry, ToRaster } from "./protocol";

export type TileResult = Extract<FromRaster, { t: "tile" }>;
export type TextResult = Extract<FromRaster, { t: "text" }>;
export type SizesResult = Extract<FromRaster, { t: "sizes" }>;
export type EditedResult = Extract<FromRaster, { t: "edited" }>;
type Unsent<T> = T extends unknown ? Omit<T, "id"> : never;
export type FormResult = Omit<Extract<FromRaster, { t: "form" }>, "t" | "seq">;

type JobMsg = Extract<ToRaster, { t: "tile" } | { t: "text" } | { t: "outline" }>;

interface Job {
	key: string;
	priority: number;
	msg: JobMsg;
	page: number;
	onDone: (res: FromRaster) => void;
	/** share of the page's content the job covers (1: whole page, 0: text) */
	frac: number;
	/** predicted ms on the worker it was sent to, and when it was sent */
	est: number;
	started: number;
	warm: boolean;
}

interface Lane {
	port: MessagePort;
	ready: boolean;
	busy: Job | null;
	/** mirrors the worker's page LRU (most recent first) */
	pages: number[];
	/** a cancel is on its way for the busy job */
	cancelling: boolean;
	/** last reported WASM heap + block cache bytes */
	heap: number;
	/** form edits made before this worker opened the document, replayed once it has */
	backlog: ToRaster[];
}

/**
 * ms = content × frac (+ overhead on a worker that has not loaded the page: parse,
 * image decode). Rendering walks the content a tile covers, so cost follows the
 * share of the page, not the pixel count. Overhead is only trusted once a warm
 * render of the page tells the two apart; until then it counts as zero.
 */
interface PageCost {
	content: number;
	overhead: number;
	warm: number;
	/** the first cold render, kept until a warm one splits it */
	cold?: { ms: number; frac: number };
}
/** pages a worker keeps loaded (raster-worker's PAGE_CACHE) */
const WORKER_PAGES = 8;
/** jobs below this priority are on screen (or a flight's destination) */
export const URGENT = 20;
const DEFAULT_CONTENT = 30;
const TEXT_MS = 4;
const MIN_FRAC = 0.002;
const EMA = 0.3;
/** jobs considered per dispatch round */
const LOOKAHEAD = 64;
/** what loading a page costs a worker that does not have it while the file is still remote (a range round trip or more) */
const REMOTE_PAGE_MS = 400;

/**
 * Raster workers for this device: half the cores (2-4) on desktops, 2 where
 * memory is short (each worker holds its own PDFium heap: more workers did not
 * beat 4 on heavy scans and cost ~40% more memory), 2 on phones and tablets
 * (1 when the browser reports 2GB or less).
 */
export function rasterWorkerCount({ cores, memoryGB, touch }: { cores?: number; memoryGB?: number; touch: boolean }) {
	if (touch) return memoryGB !== undefined && memoryGB <= 2 ? 1 : 2;
	const n = Math.min(4, Math.max(2, Math.floor((cores || 4) / 2)));
	return memoryGB !== undefined && memoryGB <= 4 ? 2 : n;
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)]! : undefined;
};

export class RasterPool {
	private lanes: Lane[];
	private queue = new Map<string, Job>();
	private inflight = new Map<number, Job>();
	private costs = new Map<number, PageCost>();
	private prior: PageCost = { content: DEFAULT_CONTENT, overhead: 0, warm: 0 };
	/** what extracting a page's text takes once loaded (scans decode their image for dark mode) */
	private textMs = TEXT_MS;
	private nextId = 1;
	/** in-flight tile jobs the last plan no longer wanted (cancelled when visible work waits) */
	private unwanted = new Set<number>();
	onOpened: (pageCount: number, sizes: SizeEntry[], info: DocumentInfo, timing?: OpenTiming) => void = () => {};
	/**
	 * While workers read the document over the network, a page another worker
	 * already loaded costs a download to load again: its jobs stay there.
	 */
	affinity = false;
	onIdle: () => void = () => {};
	onError: (message: string, code: ErrorCode, phase: ErrorPhase, detail?: LoadFailureDetail) => void = (m) => console.error(m);
	now: () => number = () => performance.now();

	constructor(ports: MessagePort[]) {
		this.lanes = ports.map((port) => ({ port, ready: false, busy: null, pages: [], cancelling: false, heap: 0, backlog: [] }));
		this.lanes.forEach((lane, i) => {
			lane.port.onmessage = (ev: MessageEvent<FromRaster>) => this.receive(lane, i, ev.data);
		});
	}

	get pending() {
		return this.queue.size + this.inflight.size;
	}

	get workers() {
		return this.lanes.length;
	}

	/** memory held by all PDFium workers (heaps + block caches), bytes */
	get heapBytes() {
		return this.lanes.reduce((sum, l) => sum + l.heap, 0);
	}

	has(key: string) {
		if (this.queue.has(key)) return true;
		for (const job of this.inflight.values()) if (job.key === key) return true;
		return false;
	}

	/** Predicted ms to render the whole of `page` on a worker that has not loaded it, and the part of that spent loading it. */
	predict(page: number) {
		const c = this.known(page);
		return { ms: c.overhead + c.content, overhead: c.overhead };
	}

	private known(page: number) {
		const c = this.costs.get(page);
		return c && c.warm ? c : { ...this.prior, content: c?.cold?.ms ?? this.prior.content };
	}

	/** benches: queued jobs by priority */
	debugQueue() {
		return [...this.queue.values()].sort((a, b) => a.priority - b.priority).map((j) => `${j.key}@${j.priority.toFixed(2)}`);
	}

	/** Add or re-prioritise a job. Lower priority runs first. */
	request(
		key: string,
		priority: number,
		msg:
			| Omit<Extract<ToRaster, { t: "tile" }>, "id">
			| Omit<Extract<ToRaster, { t: "text" }>, "id">
			| Omit<Extract<ToRaster, { t: "outline" }>, "id">
			| Omit<Extract<ToRaster, { t: "sizes" }>, "id">,
		onDone: (res: FromRaster) => void,
		frac = msg.t === "tile" ? 1 : 0,
	) {
		const queued = this.queue.get(key);
		if (queued) {
			queued.priority = priority;
			return;
		}
		for (const job of this.inflight.values()) {
			if (job.key !== key) continue;
			this.unwanted.delete(job.msg.id);
			return;
		}
		const id = this.nextId++;
		this.queue.set(key, { key, priority, msg: { ...msg, id } as JobMsg, page: msg.page, onDone, frac, est: 0, started: 0, warm: false });
	}

	/** Drop queued tile jobs whose key is not in `keep` (text jobs are cheap and always kept); unwanted running tiles may be cancelled. */
	retain(keep: Set<string>) {
		for (const job of this.queue.values()) if (job.msg.t === "tile" && !job.key.startsWith("thumb:") && !keep.has(job.key)) this.queue.delete(job.key);
		this.unwanted.clear();
		for (const job of this.inflight.values()) if (job.msg.t === "tile" && !job.key.startsWith("thumb:") && !keep.has(job.key)) this.unwanted.add(job.msg.id);
	}

	/** Stops listening to the workers and drops every job (their callbacks never run). */
	dispose() {
		for (const lane of this.lanes) {
			lane.port.onmessage = null;
			lane.port.close();
		}
		this.lanes = [];
		this.queue.clear();
		this.inflight.clear();
	}

	private formSeq = 0;
	private formWaiters = new Map<number, (res: FormResult) => void>();
	private saveWaiters = new Map<number, (res: Extract<FromRaster, { t: "saved" }>) => void>();

	/**
	 * Applies a form edit in every worker, in order with their jobs: a job sent
	 * after this renders the edited document. The first worker reports what changed.
	 */
	form(op: FormOp): Promise<FormResult> {
		const seq = ++this.formSeq;
		const done = new Promise<FormResult>((resolve) => this.formWaiters.set(seq, resolve));
		this.lanes.forEach((lane, i) => {
			const msg: ToRaster = { t: "form", seq, op, report: i === 0 };
			if (lane.ready) lane.port.postMessage(msg);
			else lane.backlog.push(msg);
		});
		return done;
	}

	/** The document bytes with every form edit, from the first worker. */
	save(): Promise<ArrayBuffer> {
		const id = this.nextId++;
		const lane = this.lanes[0];
		if (!lane) return Promise.reject(new Error("no raster worker"));
		const msg: ToRaster = { t: "save", id };
		return new Promise((resolve, reject) => {
			this.saveWaiters.set(id, (res) => (res.buf ? resolve(res.buf) : reject(new Error(res.error ?? "save failed"))));
			if (lane.ready) lane.port.postMessage(msg);
			else lane.backlog.push(msg);
		});
	}

	/** answers to edits and object queries, by id (only the first worker answers count) */
	private replies = new Map<number, (res: FromRaster) => void>();

	/** Like `form`: every worker applies the edit in order with its jobs; the first worker's answer settles it. */
	edit(msg: Unsent<Extract<ToRaster, { t: "edit" } | { t: "undo" } | { t: "redo" }>>, onDone: (res: EditedResult) => void) {
		const id = this.nextId++;
		const full = { ...msg, id } as ToRaster;
		this.replies.set(id, onDone as (res: FromRaster) => void);
		for (const lane of this.lanes) {
			if (lane.ready) lane.port.postMessage(full);
			else lane.backlog.push(full);
		}
	}

	/** A page's objects, from the first worker (in order with the edits sent before). */
	objects(page: number, onDone: (res: FromRaster) => void) {
		const id = this.nextId++;
		this.replies.set(id, onDone);
		const lane = this.lanes[0]!;
		const msg: ToRaster = { t: "objects", id, page };
		if (lane.ready) lane.port.postMessage(msg);
		else lane.backlog.push(msg);
	}

	/** Retry opening the document with a password in every worker that has not opened it. */
	unlock(password: string) {
		for (const lane of this.lanes) if (!lane.ready) lane.port.postMessage({ t: "unlock", password } satisfies ToRaster);
	}

	private cost(job: Job, warm: boolean) {
		const c = this.known(job.page);
		const work = job.msg.t === "tile" ? c.content * job.frac : job.msg.t === "text" ? this.textMs : TEXT_MS;
		if (warm) return work;
		// Range loading: loading a page another worker has means downloading it again.
		const elsewhere = this.affinity && job.page >= 0 && this.lanes.some((l) => l.pages.includes(job.page));
		return work + c.overhead + (elsewhere ? REMOTE_PAGE_MS : 0);
	}

	/** ms until a busy lane frees up; a job past its estimate is assumed to take as long again */
	private remaining(lane: Lane, now: number) {
		const job = lane.busy;
		if (!job) return 0;
		const elapsed = now - job.started;
		return job.est > elapsed ? job.est - elapsed : Math.max(1, elapsed);
	}

	pump() {
		if (this.queue.size === 0) return;
		const now = this.now();
		const jobs = [...this.queue.values()].sort((a, b) => a.priority - b.priority);
		const free = this.lanes.map((l) => (!l.ready ? Infinity : this.remaining(l, now)));
		const pages = this.lanes.map((l) => new Set(l.pages));
		const taken = new Set<Lane>();
		let urgentWaiting = 0;
		for (let j = 0; j < jobs.length && j < LOOKAHEAD; j++) {
			const job = jobs[j]!;
			let best = -1;
			let bestAt = Infinity;
			for (let i = 0; i < this.lanes.length; i++) {
				if (free[i] === Infinity) continue;
				const at = free[i]! + this.cost(job, pages[i]!.has(job.page));
				if (at < bestAt) {
					bestAt = at;
					best = i;
				}
			}
			if (best < 0) break;
			// Selection waits on text: it never queues behind a busy worker while another sits idle (unless that means a download).
			if (job.msg.t === "text" && (this.lanes[best]!.busy || taken.has(this.lanes[best]!))) {
				const idle = this.affinity ? -1 : this.lanes.findIndex((l, i) => free[i] === 0 && !l.busy && !taken.has(l));
				if (idle >= 0) {
					best = idle;
					bestAt = this.cost(job, pages[idle]!.has(job.page));
				}
			}
			const lane = this.lanes[best]!;
			free[best] = bestAt;
			pages[best]!.add(job.page);
			if (lane.busy || taken.has(lane)) {
				if (job.priority < URGENT) urgentWaiting++;
				continue;
			}
			taken.add(lane);
			this.dispatch(lane, job, now);
		}
		if (urgentWaiting) this.cancelUnwanted(urgentWaiting);
	}

	private dispatch(lane: Lane, job: Job, now: number) {
		job.warm = lane.pages.includes(job.page);
		job.est = this.cost(job, job.warm);
		job.started = now;
		this.queue.delete(job.key);
		lane.busy = job;
		this.inflight.set(job.msg.id, job);
		lane.pages = [job.page, ...lane.pages.filter((p) => p !== job.page)].slice(0, WORKER_PAGES);
		lane.port.postMessage(job.msg);
	}

	/** Visible work is waiting behind tiles nobody wants any more: stop up to `n` of those. */
	private cancelUnwanted(n: number) {
		for (const lane of this.lanes) {
			if (n === 0) return;
			const job = lane.busy;
			if (!job || lane.cancelling || !this.unwanted.has(job.msg.id)) continue;
			lane.cancelling = true;
			lane.port.postMessage({ t: "cancel", id: job.msg.id } satisfies ToRaster);
			n--;
		}
	}

	private learn(job: Job, ms: number) {
		if (job.msg.t === "text") {
			this.textMs += (ms - this.textMs) * EMA;
			return;
		}
		if (job.msg.t !== "tile") return;
		const frac = Math.max(MIN_FRAC, job.frac);
		const c = this.costs.get(job.page) ?? { content: 0, overhead: 0, warm: 0 };
		if (job.warm) {
			c.content = c.warm ? c.content + (ms / frac - c.content) * EMA : ms / frac;
			c.warm++;
			if (c.cold) {
				c.overhead = Math.max(0, c.cold.ms - c.content * c.cold.frac);
				c.cold = undefined;
			}
		} else if (c.warm) c.overhead += (Math.max(0, ms - c.content * frac) - c.overhead) * EMA;
		else c.cold ??= { ms, frac };
		this.costs.set(job.page, c);
		// Pages of one document cost alike: unseen pages start from the typical page.
		const known = [...this.costs.values()].filter((k) => k.warm);
		if (known.length) this.prior = { content: median(known.map((k) => k.content))!, overhead: median(known.map((k) => k.overhead))!, warm: 0 };
	}



	/** The whole file is local now: any worker can take any page. */
	releaseAffinity() {
		this.affinity = false;
		this.pump();
	}

	private receive(lane: Lane, index: number, msg: FromRaster) {
		if (msg.t === "form") {
			this.formWaiters.get(msg.seq)?.(msg);
			this.formWaiters.delete(msg.seq);
			return;
		}
		if (msg.t === "edited" || msg.t === "objects" || (msg.t === "error" && msg.id !== undefined && this.replies.has(msg.id))) {
			if ("heap" in msg) lane.heap = msg.heap;
			if (index !== 0) return;
			const done = this.replies.get(msg.id!);
			this.replies.delete(msg.id!);
			done?.(msg);
			return;
		}
		if (msg.t === "saved") {
			this.saveWaiters.get(msg.id)?.(msg);
			this.saveWaiters.delete(msg.id);
			return;
		}
		if (msg.t === "opened") {
			lane.ready = true;
			for (const m of lane.backlog.splice(0)) lane.port.postMessage(m);
			const { wasmMs, wasmShared = false, openMs } = msg;
			if (index === 0) this.onOpened(msg.pageCount, msg.sizes, msg.info, wasmMs !== undefined && openMs !== undefined ? { wasmMs, wasmShared, openMs } : undefined);
			this.pump();
			return;
		}
		if (msg.t === "error") {
			// Every worker opens the same bytes: report load failures once.
			const load = msg.phase === "document-load" || msg.phase === "engine-load";
			if (!load || index === 0) this.onError(msg.message, msg.code, msg.phase, msg.detail);
			const job = lane.busy;
			if (job) {
				this.inflight.delete(job.msg.id);
				lane.busy = null;
				lane.cancelling = false;
			}
			this.pump();
			// The job's owner learns it failed (text waiters, tiles that must not retry forever).
			if (job) job.onDone(msg);
			return;
		}
		if ("heap" in msg) lane.heap = msg.heap;
		const job = this.inflight.get(msg.id);
		this.inflight.delete(msg.id);
		this.unwanted.delete(msg.id);
		if (lane.busy?.msg.id === msg.id) {
			lane.busy = null;
			lane.cancelling = false;
		}
		if (job && (msg.t === "tile" || msg.t === "text")) this.learn(job, msg.ms);
		this.pump();
		// A cancelled tile is forgotten: the next plan requests it again if it is still wanted.
		if (msg.t !== "cancelled") job?.onDone(msg);
		if (this.pending === 0) this.onIdle();
	}
}
