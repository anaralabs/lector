// No runtime imports: tests load this file directly in Node.

/** tries per request, the first included */
export const RETRY_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 1000;
/** the longest a request waits for an offline browser to come back, across all its tries */
export const ONLINE_WAIT_MS = 15_000;

/** A status worth another try: a dropped connection, a timeout, a rate limit or a server error. */
export function retryableStatus(status: number): boolean {
	return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** fetch rejects with a TypeError when the request never got an answer ("Failed to fetch", Safari's "Load failed") */
export function isNetworkError(err: unknown): boolean {
	return err instanceof TypeError;
}

/** The wait before retry `retry` (1-based): 250ms, 500ms, 1s, ... with jitter in its upper half. */
export function backoffMs(retry: number, random: () => number = Math.random): number {
	const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (retry - 1));
	return Math.round(base / 2 + (random() * base) / 2);
}

/** Where connectivity is read from: the page or worker globals by default. */
export interface Connectivity {
	online(): boolean;
	/** fires `online` */
	events: EventTarget | null;
}

const globalConnectivity: Connectivity = {
	online: () => typeof navigator === "undefined" || navigator.onLine !== false,
	events: typeof (globalThis as Partial<EventTarget>).addEventListener === "function" ? (globalThis as unknown as EventTarget) : null,
};

export interface RetryOptions {
	signal?: AbortSignal | null;
	attempts?: number;
	onlineWaitMs?: number;
	random?: () => number;
	connectivity?: Connectivity;
}

function aborted(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Resolves after `ms`, or earlier on `event` from `events`; rejects as soon as `signal` aborts. */
export function wait(ms: number, signal?: AbortSignal | null, events?: EventTarget | null, event = "online"): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(aborted(signal));
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			events?.removeEventListener(event, done);
		};
		const done = () => {
			cleanup();
			resolve();
		};
		const stop = () => {
			cleanup();
			reject(aborted(signal!));
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", stop, { once: true });
		events?.addEventListener(event, done, { once: true });
	});
}

/** Waits (at most `maxMs`) for an offline browser to come back; true once it is online. */
export async function untilOnline(maxMs: number, signal?: AbortSignal | null, connectivity: Connectivity = globalConnectivity): Promise<boolean> {
	if (connectivity.online()) return true;
	if (connectivity.events) await wait(maxMs, signal, connectivity.events);
	return connectivity.online();
}

/** Runs `attempt` with backoff until it succeeds or fails for good; an offline browser is waited for instead of spending tries. */
export async function retrying<T>(attempt: (n: number) => Promise<T>, retryable: (err: unknown) => boolean, o: RetryOptions = {}): Promise<T> {
	const attempts = o.attempts ?? RETRY_ATTEMPTS;
	const connectivity = o.connectivity ?? globalConnectivity;
	let onlineBudget = o.onlineWaitMs ?? ONLINE_WAIT_MS;
	for (let n = 1; ; n++) {
		if (onlineBudget > 0 && !connectivity.online()) {
			const t0 = Date.now();
			const back = await untilOnline(onlineBudget, o.signal, connectivity);
			onlineBudget = back ? onlineBudget - (Date.now() - t0) : 0;
		}
		if (o.signal?.aborted) throw aborted(o.signal);
		try {
			return await attempt(n);
		} catch (err) {
			if (o.signal?.aborted || n >= attempts || !retryable(err)) throw err;
		}
		await wait(backoffMs(n, o.random), o.signal);
	}
}

class RetryableResponse extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`HTTP ${status}`);
		this.status = status;
	}
}

/** `fetch` retrying network errors and retryable statuses; the last try's response comes back whatever its status. */
export function fetchRetrying(input: string, init: RequestInit = {}, o: RetryOptions & { fetch?: typeof fetch } = {}): Promise<Response> {
	const request = o.fetch ?? fetch;
	const attempts = o.attempts ?? RETRY_ATTEMPTS;
	return retrying(
		async (n) => {
			const res = await request(input, init);
			if (n < attempts && retryableStatus(res.status)) {
				void res.body?.cancel().catch(() => {});
				throw new RetryableResponse(res.status);
			}
			return res;
		},
		(err) => err instanceof RetryableResponse || isNetworkError(err),
		{ ...o, signal: o.signal ?? init.signal },
	);
}

/** Repeats a synchronous request while it fails retryably, blocking between tries; offline it gives up at once so the caller can wait. */
export function retryingSync<T extends { status: number }>(request: () => T, o: Pick<RetryOptions, "attempts" | "random" | "connectivity"> & { sleep?: (ms: number) => void } = {}): T {
	const attempts = o.attempts ?? RETRY_ATTEMPTS;
	const online = (o.connectivity ?? globalConnectivity).online;
	let res = request();
	for (let retry = 1; retry < attempts && retryableStatus(res.status) && online(); retry++) {
		(o.sleep ?? sleepSync)(backoffMs(retry, o.random));
		res = request();
	}
	return res;
}

/** Blocks this worker for `ms`: PDFium's synchronous byte callback has no event loop to wait on. */
export function sleepSync(ms: number): void {
	if (typeof SharedArrayBuffer === "function" && typeof Atomics?.wait === "function") {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
			return;
		} catch {}
	}
	const until = performance.now() + ms;
	while (performance.now() < until);
}
