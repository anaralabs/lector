import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffMs, type Connectivity, fetchRetrying, retryableStatus, retryingSync, sleepSync } from "../src/retry.ts";

const fast = { random: () => 0 };
const online: Connectivity = { online: () => true, events: null };

/** A fetch that answers from `script` in order: a status, or an error to reject with. */
const scripted = (script: (number | Error)[]) => {
	const calls: RequestInit[] = [];
	const fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
		calls.push(init);
		const next = script[Math.min(calls.length - 1, script.length - 1)]!;
		if (next instanceof Error) throw next;
		return new Response(next === 204 ? null : "x", { status: next });
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
};

test("retryable statuses: dropped connections, timeouts, rate limits and server errors; not client errors", () => {
	for (const status of [0, 408, 429, 500, 503]) assert.equal(retryableStatus(status), true, String(status));
	for (const status of [200, 206, 400, 401, 403, 404, 416]) assert.equal(retryableStatus(status), false, String(status));
});

test("backoff doubles from 250ms to a 1s cap, jittered within the upper half", () => {
	assert.deepEqual([1, 2, 3, 4, 8].map((n) => backoffMs(n, () => 0)), [125, 250, 500, 500, 500]);
	assert.deepEqual([1, 2, 3, 4].map((n) => backoffMs(n, () => 1)), [250, 500, 1000, 1000]);
});

test("a dropped connection, then success: the response comes back", async () => {
	const { fetch, calls } = scripted([new TypeError("Failed to fetch"), 206]);
	const res = await fetchRetrying("/a.pdf", {}, { fetch, connectivity: online, ...fast });
	assert.equal(res.status, 206);
	assert.equal(calls.length, 2);
});

test("a server error, then success", async () => {
	const { fetch, calls } = scripted([503, 429, 206]);
	assert.equal((await fetchRetrying("/a.pdf", {}, { fetch, connectivity: online, ...fast })).status, 206);
	assert.equal(calls.length, 3);
});

test("three dropped connections: the same error as without retries", async () => {
	const err = new TypeError("Load failed");
	const { fetch, calls } = scripted([err]);
	await assert.rejects(fetchRetrying("/a.pdf", {}, { fetch, connectivity: online, ...fast }), (e) => e === err);
	assert.equal(calls.length, 3);
});

test("three server errors: the last response, for the caller to judge as before", async () => {
	const { fetch, calls } = scripted([502, 500, 503]);
	assert.equal((await fetchRetrying("/a.pdf", {}, { fetch, connectivity: online, ...fast })).status, 503);
	assert.equal(calls.length, 3);
});

test("404 and 403 are not retried", async () => {
	for (const status of [404, 403]) {
		const { fetch, calls } = scripted([status, 206]);
		assert.equal((await fetchRetrying("/a.pdf", {}, { fetch, connectivity: online, ...fast })).status, status);
		assert.equal(calls.length, 1);
	}
});

test("aborting during the backoff stops at once, with no further request", async () => {
	const ac = new AbortController();
	const { fetch, calls } = scripted([new TypeError("Failed to fetch"), 206]);
	const t0 = performance.now();
	const done = fetchRetrying("/a.pdf", { signal: ac.signal }, { fetch, connectivity: online, random: () => 1 });
	setTimeout(() => ac.abort(), 20);
	await assert.rejects(done, (e: Error) => e.name === "AbortError");
	assert.ok(performance.now() - t0 < 200, "did not wait out the 250ms backoff");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(calls.length, 1);
});

test("an already aborted signal makes no request", async () => {
	const ac = new AbortController();
	ac.abort();
	const { fetch, calls } = scripted([206]);
	await assert.rejects(fetchRetrying("/a.pdf", { signal: ac.signal }, { fetch, connectivity: online }), (e: Error) => e.name === "AbortError");
	assert.equal(calls.length, 0);
});

test("an abort error from fetch itself is not retried", async () => {
	const ac = new AbortController();
	const { fetch, calls } = scripted([new DOMException("aborted", "AbortError")]);
	ac.abort();
	await assert.rejects(fetchRetrying("/a.pdf", {}, { fetch, connectivity: online, ...fast }), (e: Error) => e.name === "AbortError");
	assert.equal(calls.length, 1);
});

const offline = () => {
	const events = new EventTarget();
	let on = false;
	const connectivity: Connectivity = { online: () => on, events };
	const back = () => {
		on = true;
		events.dispatchEvent(new Event("online"));
	};
	return { connectivity, back };
};

test("offline: waits for the browser to come back instead of spending tries", async () => {
	const net = offline();
	const { fetch, calls } = scripted([206]);
	const done = fetchRetrying("/a.pdf", {}, { fetch, connectivity: net.connectivity, ...fast });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(calls.length, 0);
	net.back();
	assert.equal((await done).status, 206);
	assert.equal(calls.length, 1);
});

test("offline: the wait is bounded, then the tries run and fail as before", async () => {
	const net = offline();
	const err = new TypeError("Failed to fetch");
	const { fetch, calls } = scripted([err]);
	const t0 = performance.now();
	await assert.rejects(fetchRetrying("/a.pdf", {}, { fetch, connectivity: net.connectivity, onlineWaitMs: 60, ...fast }), (e) => e === err);
	assert.equal(calls.length, 3);
	assert.ok(performance.now() - t0 < 1000, "one bounded wait, not one per try");
});

test("offline: aborting while waiting for the network stops at once", async () => {
	const net = offline();
	const ac = new AbortController();
	const { fetch, calls } = scripted([206]);
	const done = fetchRetrying("/a.pdf", { signal: ac.signal }, { fetch, connectivity: net.connectivity });
	setTimeout(() => ac.abort(), 20);
	await assert.rejects(done, (e: Error) => e.name === "AbortError");
	assert.equal(calls.length, 0);
});

test("sync range reads: status 0 then 206 is read; 404 once; three failures give the last status", () => {
	const run = (statuses: number[], connectivity = online) => {
		const slept: number[] = [];
		let i = 0;
		const res = retryingSync(() => ({ status: statuses[Math.min(i++, statuses.length - 1)]! }), { connectivity, sleep: (ms) => slept.push(ms), random: () => 0 });
		return { status: res.status, requests: i, slept };
	};
	assert.deepEqual(run([0, 206]), { status: 206, requests: 2, slept: [125] });
	assert.deepEqual(run([404, 206]), { status: 404, requests: 1, slept: [] });
	assert.deepEqual(run([0, 503, 0]), { status: 0, requests: 3, slept: [125, 250] });
	// offline: give up at once so the open can wait for the network
	assert.deepEqual(run([0, 206], { online: () => false, events: null }), { status: 0, requests: 1, slept: [] });
});

test("sleepSync blocks for about the time asked", () => {
	const t0 = performance.now();
	sleepSync(30);
	assert.ok(performance.now() - t0 >= 29);
});
