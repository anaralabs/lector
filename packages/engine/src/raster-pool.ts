// Schedules tile and text jobs across independent PDFium workers.
// The core re-plans every frame: jobs that are no longer wanted are dropped
// before dispatch, and the most urgent jobs go out first.

import type { DocumentInfo, ErrorCode, ErrorPhase, FromRaster, SizeEntry, ToRaster } from "./protocol";

export type TileResult = Extract<FromRaster, { t: "tile" }>;
export type TextResult = Extract<FromRaster, { t: "text" }>;
export type SizesResult = Extract<FromRaster, { t: "sizes" }>;

interface Job {
	key: string;
	priority: number;
	msg: ToRaster & { id: number };
	page: number;
	onDone: (res: FromRaster) => void;
}

interface Lane {
	port: MessagePort;
	ready: boolean;
	busy: Job | null;
	recentPages: number[];
	/** last reported WASM heap + block cache bytes */
	heap: number;
}

export class RasterPool {
	private lanes: Lane[];
	private queue = new Map<string, Job>();
	private inflight = new Map<number, Job>();
	private nextId = 1;
	onOpened: (pageCount: number, sizes: SizeEntry[], info: DocumentInfo) => void = () => {};
	/**
	 * While workers read the document over the network, a page's jobs stay on
	 * the worker that already loaded it: another worker would download and
	 * parse that page again.
	 */
	affinity = false;
	private owner = new Map<number, Lane>();
	onIdle: () => void = () => {};
	onError: (message: string, code: ErrorCode, phase: ErrorPhase) => void = (m) => console.error(m);

	constructor(ports: MessagePort[]) {
		this.lanes = ports.map((port) => ({ port, ready: false, busy: null, recentPages: [], heap: 0 }));
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
	) {
		const queued = this.queue.get(key);
		if (queued) {
			queued.priority = priority;
			return;
		}
		for (const job of this.inflight.values()) if (job.key === key) return;
		const id = this.nextId++;
		this.queue.set(key, { key, priority, msg: { ...msg, id } as Job["msg"], page: msg.page, onDone });
	}

	/** Drop queued tile jobs whose key is not in `keep` (in-flight jobs finish; text jobs are cheap and always kept). */
	retain(keep: Set<string>) {
		for (const job of this.queue.values()) if (job.msg.t === "tile" && !job.key.startsWith("thumb:") && !keep.has(job.key)) this.queue.delete(job.key);
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
		this.owner.clear();
	}

	/** Retry opening the document with a password in every worker that has not opened it. */
	unlock(password: string) {
		for (const lane of this.lanes) if (!lane.ready) lane.port.postMessage({ t: "unlock", password } satisfies ToRaster);
	}

	pump() {
		if (this.queue.size === 0) return;
		const jobs = [...this.queue.values()].sort((a, b) => a.priority - b.priority);
		for (const lane of this.lanes) {
			if (!lane.ready || lane.busy || jobs.length === 0) continue;
			const pick = this.affinity ? this.pickOwned(lane, jobs) : this.pickNear(lane, jobs);
			if (pick < 0) continue;
			const [job] = jobs.splice(pick, 1);
			if (!job) continue;
			this.queue.delete(job.key);
			lane.busy = job;
			this.inflight.set(job.msg.id, job);
			lane.recentPages = [job.page, ...lane.recentPages.filter((p) => p !== job.page)].slice(0, 6);
			if (this.affinity && job.page >= 0 && !this.owner.has(job.page)) this.owner.set(job.page, lane);
			lane.port.postMessage(job.msg);
		}
	}

	/** Prefer a near-top job for a page this worker has already parsed. */
	private pickNear(lane: Lane, jobs: Job[]) {
		const window = Math.min(jobs.length, 4);
		for (let i = 0; i < window; i++) if (lane.recentPages.includes(jobs[i]!.page)) return i;
		return 0;
	}

	/** The most urgent job for a page this worker owns or nobody does yet; other workers' pages wait for them. */
	private pickOwned(lane: Lane, jobs: Job[]) {
		for (let i = 0; i < jobs.length; i++) {
			const owner = jobs[i]!.page >= 0 ? this.owner.get(jobs[i]!.page) : undefined;
			if (!owner || owner === lane || !this.lanes.includes(owner) || !owner.ready) return i;
		}
		return -1;
	}

	/** The whole file is local now: any worker can take any page. */
	releaseAffinity() {
		this.affinity = false;
		this.owner.clear();
		this.pump();
	}

	private receive(lane: Lane, index: number, msg: FromRaster) {
		if (msg.t === "opened") {
			lane.ready = true;
			if (index === 0) this.onOpened(msg.pageCount, msg.sizes, msg.info);
			this.pump();
			return;
		}
		if (msg.t === "error") {
			// Every worker opens the same bytes: report load failures once.
			const load = msg.phase === "document-load" || msg.phase === "engine-load";
			if (!load || index === 0) this.onError(msg.message, msg.code, msg.phase);
			const job = lane.busy;
			if (job) {
				this.inflight.delete(job.msg.id);
				lane.busy = null;
			}
			this.pump();
			// The job's owner learns it failed (text waiters, tiles that must not retry forever).
			if (job) job.onDone(msg);
			return;
		}
		if ("heap" in msg) lane.heap = msg.heap;
		const job = this.inflight.get(msg.id);
		this.inflight.delete(msg.id);
		lane.busy = null;
		this.pump();
		job?.onDone(msg);
		if (this.pending === 0) this.onIdle();
	}
}
