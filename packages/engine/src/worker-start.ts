// Starts a worker and retries one whose script failed to load: Safari after sleep/wake and flaky networks fail a module fetch for a few seconds.

export type WorkerType = "module" | "classic";

/** Builds the engine's workers; `type` is "classic" where the browser has no module workers. */
export type CreateWorker = (url: URL, name: string, options?: { type: WorkerType }) => Worker;

/** waits before each retry of a worker that never booted */
export const WORKER_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

/** The same script under a fresh URL, so no cached failure of the first fetch is reused. */
export function retryUrl(url: URL, attempt: number, stamp = Date.now()): URL {
	if (attempt === 0) return url;
	const fresh = new URL(url.href);
	fresh.searchParams.set("lector-retry", `${attempt}-${stamp.toString(36)}`);
	return fresh;
}

export interface StartWorkerOptions {
	/** a fresh worker for this attempt (0 first, then each retry) */
	create: (attempt: number) => Worker;
	onmessage?: (ev: MessageEvent) => void;
	/** every attempt failed before the worker booted */
	onLoadFailed: (ev: ErrorEvent) => void;
	/** a booted worker threw outside a request */
	onCrashed: (ev: ErrorEvent) => void;
	stopped: () => boolean;
	delays?: readonly number[];
	/** resolves once the network may be back (default: now, or the next `online` event while offline) */
	online?: () => Promise<void>;
}

export interface StartedWorker {
	current: () => Worker;
	/** resolves with the worker once it posted `boot`; never settles if it could not load */
	booted: Promise<Worker>;
}

function whenOnline(): Promise<void> {
	if (typeof navigator === "undefined" || navigator.onLine !== false || typeof addEventListener !== "function") return Promise.resolve();
	return new Promise((resolve) => addEventListener("online", () => resolve(), { once: true }));
}

export function startWorker({ create, onmessage, onLoadFailed, onCrashed, stopped, delays = WORKER_RETRY_DELAYS_MS, online = whenOnline }: StartWorkerOptions): StartedWorker {
	let worker: Worker;
	let resolveBooted: (w: Worker) => void = () => {};
	const booted = new Promise<Worker>((resolve) => {
		resolveBooted = resolve;
	});
	const start = (attempt: number) => {
		const w = create(attempt);
		worker = w;
		let isBooted = false;
		if (onmessage) w.onmessage = onmessage;
		const onBoot = (ev: MessageEvent) => {
			if ((ev.data as { t?: string } | null)?.t !== "boot") return;
			w.removeEventListener("message", onBoot);
			isBooted = true;
			resolveBooted(w);
		};
		w.addEventListener("message", onBoot);
		w.addEventListener("error", (ev) => {
			if (stopped() || w !== worker) return;
			if (isBooted) {
				onCrashed(ev);
				return;
			}
			w.terminate();
			const delay = delays[attempt];
			if (delay === undefined) {
				onLoadFailed(ev);
				return;
			}
			setTimeout(() => {
				if (stopped()) return;
				void online().then(() => {
					if (!stopped()) start(attempt + 1);
				});
			}, delay);
		});
	};
	start(0);
	return { current: () => worker, booted };
}
