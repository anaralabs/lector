import assert from "node:assert/strict";
import { test } from "node:test";
import { retryUrl, startWorker, type StartWorkerOptions, WORKER_RETRY_DELAYS_MS } from "../src/worker-start.ts";

type Listener = (ev: { data?: unknown; message?: string }) => void;

class FakeWorker {
	listeners = new Map<string, Listener[]>();
	terminated = false;
	onmessage: Listener | null = null;
	addEventListener(type: string, fn: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	removeEventListener(type: string, fn: Listener) {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
	}
	terminate() {
		this.terminated = true;
	}
	boot() {
		for (const l of this.listeners.get("message") ?? []) l({ data: { t: "boot" } });
	}
	fail(message = "Importing a module script failed.") {
		for (const l of this.listeners.get("error") ?? []) l({ message });
	}
}

/** Fake timers: `flush` runs every scheduled callback (and the microtasks they queue). */
function harness(overrides: Partial<StartWorkerOptions> = {}) {
	const workers: FakeWorker[] = [];
	const attempts: number[] = [];
	const loadFailed: string[] = [];
	const crashed: string[] = [];
	const timers: { ms: number; fn: () => void }[] = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms: number) => {
		timers.push({ fn, ms });
		return 0;
	}) as typeof setTimeout;
	let stopped = false;
	const started = startWorker({
		create: (attempt) => {
			attempts.push(attempt);
			const w = new FakeWorker();
			workers.push(w);
			return w as unknown as Worker;
		},
		onLoadFailed: (ev) => loadFailed.push(ev.message),
		onCrashed: (ev) => crashed.push(ev.message),
		stopped: () => stopped,
		online: () => Promise.resolve(),
		...overrides,
	});
	const flush = async () => {
		while (timers.length) {
			timers.shift()!.fn();
			for (let i = 0; i < 5; i++) await Promise.resolve();
		}
	};
	const restore = () => {
		globalThis.setTimeout = realSetTimeout;
	};
	return { started, workers, attempts, loadFailed, crashed, timers, flush, restore, stop: () => (stopped = true) };
}

test("a worker that loads boots without retries", async () => {
	const h = harness();
	try {
		h.workers[0]!.boot();
		assert.equal(await h.started.booted, h.workers[0]);
		assert.deepEqual(h.attempts, [0]);
		assert.equal(h.timers.length, 0);
	} finally {
		h.restore();
	}
});

test("a failed import is retried with backoff until one attempt boots", async () => {
	const h = harness();
	try {
		h.workers[0]!.fail();
		assert.equal(h.workers[0]!.terminated, true);
		assert.deepEqual(h.timers.map((t) => t.ms), [WORKER_RETRY_DELAYS_MS[0]]);
		await h.flush();
		h.workers[1]!.fail();
		assert.deepEqual(h.timers.map((t) => t.ms), [WORKER_RETRY_DELAYS_MS[1]]);
		await h.flush();
		h.workers[2]!.boot();
		assert.equal(await h.started.booted, h.workers[2]);
		assert.equal(h.started.current(), h.workers[2] as unknown as Worker);
		assert.deepEqual(h.attempts, [0, 1, 2]);
		assert.deepEqual(h.loadFailed, []);
	} finally {
		h.restore();
	}
});

test("load failure is reported once every retry has failed", async () => {
	const h = harness();
	try {
		for (let i = 0; i <= WORKER_RETRY_DELAYS_MS.length; i++) {
			h.workers[i]!.fail(`attempt ${i}`);
			await h.flush();
		}
		assert.deepEqual(h.loadFailed, [`attempt ${WORKER_RETRY_DELAYS_MS.length}`]);
		assert.equal(h.workers.length, WORKER_RETRY_DELAYS_MS.length + 1);
		assert.ok(h.workers.every((w) => w.terminated));
	} finally {
		h.restore();
	}
});

test("a booted worker that throws is a crash, not a retry", async () => {
	const h = harness();
	try {
		h.workers[0]!.boot();
		h.workers[0]!.fail("boom");
		assert.deepEqual(h.crashed, ["boom"]);
		assert.equal(h.timers.length, 0);
		assert.equal(h.workers[0]!.terminated, false);
	} finally {
		h.restore();
	}
});

test("a stopped viewer neither retries nor reports", async () => {
	const h = harness();
	try {
		h.workers[0]!.fail();
		h.stop();
		await h.flush();
		assert.equal(h.workers.length, 1);
		h.workers[0]!.fail();
		assert.deepEqual(h.loadFailed, []);
	} finally {
		h.restore();
	}
});

test("errors from a replaced worker are ignored", async () => {
	const h = harness();
	try {
		h.workers[0]!.fail();
		await h.flush();
		h.workers[0]!.fail("late");
		assert.equal(h.timers.length, 0);
		assert.deepEqual(h.loadFailed, []);
	} finally {
		h.restore();
	}
});

test("a retry waits for the network to come back", async () => {
	let online: () => void = () => {};
	const h = harness({ online: () => new Promise<void>((resolve) => (online = resolve)) });
	try {
		h.workers[0]!.fail();
		await h.flush();
		assert.equal(h.workers.length, 1);
		online();
		await Promise.resolve();
		assert.equal(h.workers.length, 2);
	} finally {
		h.restore();
	}
});

test("retries load the script from a fresh URL", () => {
	const url = new URL("https://static.example.com/assets/raster-worker-abc.js?v=1");
	assert.equal(retryUrl(url, 0), url);
	const fresh = retryUrl(url, 2, 35);
	assert.equal(fresh.searchParams.get("v"), "1");
	assert.equal(fresh.searchParams.get("lector-retry"), "2-z");
	assert.notEqual(retryUrl(url, 1, 1).href, retryUrl(url, 2, 1).href);
	assert.equal(url.search, "?v=1");
});
