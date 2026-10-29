// Schedules tile and text jobs across independent PDFium workers.
// The core re-plans every frame: jobs that are no longer wanted are dropped
// before dispatch, and the most urgent jobs go out first.

import type { DocumentInfo, ErrorCode, ErrorPhase, FromRaster, PageSize, ToRaster } from "./protocol";

export type TileResult = Extract<FromRaster, { t: "tile" }>;
export type TextResult = Extract<FromRaster, { t: "text" }>;

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
	onOpened: (pages: PageSize[], info: DocumentInfo) => void = () => {};
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
			| Omit<Extract<ToRaster, { t: "outline" }>, "id">,
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

	/** Retry opening the document with a password in every worker that has not opened it. */
	unlock(password: string) {
		for (const lane of this.lanes) if (!lane.ready) lane.port.postMessage({ t: "unlock", password } satisfies ToRaster);
	}

	pump() {
		if (this.queue.size === 0) return;
		const jobs = [...this.queue.values()].sort((a, b) => a.priority - b.priority);
		for (const lane of this.lanes) {
			if (!lane.ready || lane.busy || jobs.length === 0) continue;
			// Prefer a near-top job for a page this worker has already parsed.
			let pick = 0;
			const window = Math.min(jobs.length, 4);
			for (let i = 0; i < window; i++) {
				if (lane.recentPages.includes(jobs[i]!.page)) {
					pick = i;
					break;
				}
			}
			const [job] = jobs.splice(pick, 1);
			if (!job) continue;
			this.queue.delete(job.key);
			lane.busy = job;
			this.inflight.set(job.msg.id, job);
			lane.recentPages = [job.page, ...lane.recentPages.filter((p) => p !== job.page)].slice(0, 6);
			lane.port.postMessage(job.msg);
		}
	}

	private receive(lane: Lane, index: number, msg: FromRaster) {
		if (msg.t === "opened") {
			lane.ready = true;
			if (index === 0) this.onOpened(msg.pages, msg.info);
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
