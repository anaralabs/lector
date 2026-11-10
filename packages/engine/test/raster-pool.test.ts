import assert from "node:assert/strict";
import { test } from "node:test";
import type { FromRaster, ToRaster } from "../src/protocol.ts";
import { OOM_REDUCE, RasterPool, rasterWorkerCount, WORKER_RESTARTS } from "../src/raster-pool.ts";

class FakePort {
	sent: ToRaster[] = [];
	onmessage: ((ev: { data: FromRaster }) => void) | null = null;
	postMessage(msg: ToRaster) {
		this.sent.push(msg);
	}
	close() {}
	reply(msg: FromRaster) {
		this.onmessage?.({ data: msg });
	}
	get busy() {
		return this.sent.filter((m) => m.t === "tile" || m.t === "text").at(-1) as Extract<ToRaster, { t: "tile" }> | undefined;
	}
}

function setup(n: number) {
	const ports = Array.from({ length: n }, () => new FakePort());
	const pool = new RasterPool(ports as unknown as MessagePort[]);
	let now = 0;
	pool.now = () => now;
	for (const p of ports) p.reply({ t: "opened", pages: [], info: { pageCount: 10, encrypted: false, hasForm: false } });
	const finish = (port: FakePort, ms: number) => {
		const job = port.busy!;
		now += ms;
		port.reply({ t: "tile", id: job.id, buf: new ArrayBuffer(0), w: job.w, h: job.h, ms, heap: 0 });
	};
	/** frac: share of the page the tile covers (1 = the whole-page base) */
	const tile = (key: string, page: number, priority: number, frac = 0.1) =>
		pool.request(key, priority, { t: "tile", page, scale: 1, x: 0, y: 0, w: 512, h: 512 }, () => {}, frac);
	return { pool, ports, finish, tile, advance: (ms: number) => (now += ms) };
}

test("worker count follows cores and memory, capped on touch devices", () => {
	assert.equal(rasterWorkerCount({ cores: 4, touch: false }), 2);
	assert.equal(rasterWorkerCount({ cores: 8, touch: false }), 4);
	assert.equal(rasterWorkerCount({ cores: 16, touch: false }), 4);
	assert.equal(rasterWorkerCount({ cores: 16, memoryGB: 4, touch: false }), 2);
	assert.equal(rasterWorkerCount({ cores: 16, memoryGB: 8, touch: false }), 4);
	assert.equal(rasterWorkerCount({ touch: false }), 2);
	assert.equal(rasterWorkerCount({ cores: 8, touch: true }), 2);
	assert.equal(rasterWorkerCount({ cores: 8, memoryGB: 2, touch: true }), 1);
	assert.equal(rasterWorkerCount({ cores: 16, memoryGB: 2, touch: false }), 1);
	assert.equal(rasterWorkerCount({ cores: 16, memoryGB: 1, touch: false, software: true }), 1);
});

test("without a GPU the workers leave cores for drawing", () => {
	assert.equal(rasterWorkerCount({ cores: 2, touch: false, software: true }), 1);
	assert.equal(rasterWorkerCount({ cores: 4, touch: false, software: true }), 1);
	assert.equal(rasterWorkerCount({ cores: 8, touch: false, software: true }), 2);
	assert.equal(rasterWorkerCount({ cores: 32, memoryGB: 16, touch: false, software: true }), 2);
	assert.equal(rasterWorkerCount({ touch: false, software: true }), 1);
});

test("unknown pages spread across idle workers", () => {
	const { pool, ports, tile } = setup(3);
	for (let i = 0; i < 3; i++) tile(`t${i}`, 0, 10 + i);
	pool.pump();
	assert.deepEqual(
		ports.map((p) => p.sent.length),
		[1, 1, 1],
	);
});

test("tiles of a decode-heavy page wait for the worker that has it loaded", () => {
	const { pool, ports, finish, tile } = setup(2);
	// Page 0's base: 60ms cold (decode), then its tiles (a tenth of the page each) take 1ms on that worker.
	tile("base", 0, 0, 1);
	pool.pump();
	const [a, b] = ports;
	assert.equal(a!.sent.length, 1);
	finish(a!, 60);
	tile("t1", 0, 10);
	pool.pump();
	finish(a!, 1);
	// Now three more tiles of page 0 and a tile of an unseen page: the unseen page gets the cold worker.
	tile("t2", 0, 10);
	tile("t3", 0, 10.1);
	tile("other", 5, 30);
	pool.pump();
	assert.equal(a!.busy?.page, 0);
	assert.equal(b!.busy?.page, 5);
});

test("a cheap page (no decode overhead) still uses every worker", () => {
	const { pool, ports, finish, tile } = setup(2);
	tile("base", 0, 0, 1);
	pool.pump();
	finish(ports[0]!, 10);
	tile("t1", 0, 10);
	pool.pump();
	finish(ports[0]!, 9);
	tile("t2", 0, 10);
	tile("t3", 0, 10.1);
	pool.pump();
	assert.equal(ports[0]!.busy?.page, 0);
	assert.ok(ports[1]!.sent.some((m) => m.t === "tile" && m.page === 0), "the second worker takes a tile of the same page");
});

test("visible work cancels running tiles the plan dropped, and a cancelled tile is forgotten", () => {
	const { pool, ports, tile, finish } = setup(1);
	let done = 0;
	pool.request("old", 30, { t: "tile", page: 3, scale: 1, x: 0, y: 0, w: 512, h: 512 }, () => done++);
	pool.pump();
	const old = ports[0]!.busy!;
	pool.retain(new Set(["new"]));
	tile("new", 1, 10);
	pool.pump();
	assert.deepEqual(ports[0]!.sent.at(-1), { t: "cancel", id: old.id });
	ports[0]!.reply({ t: "cancelled", id: old.id, heap: 0 });
	assert.equal(done, 0);
	assert.equal(pool.has("old"), false);
	assert.equal(ports[0]!.busy?.page, 1);
	finish(ports[0]!, 5);
	assert.equal(pool.pending, 0);
});

test("a dropped tile that is wanted again is not cancelled", () => {
	const { pool, ports, tile } = setup(1);
	tile("a", 3, 30);
	pool.pump();
	pool.retain(new Set());
	tile("a", 3, 10);
	tile("b", 1, 10);
	pool.pump();
	assert.ok(!ports[0]!.sent.some((m) => m.t === "cancel"));
});

test("predictions split decode overhead from content once a warm render is seen", () => {
	const { pool, ports, finish, tile } = setup(1);
	tile("base", 2, 0, 1);
	pool.pump();
	finish(ports[0]!, 80);
	assert.equal(pool.predict(2).overhead, 0, "one cold render cannot tell decode from content");
	tile("t", 2, 10, 0.1);
	pool.pump();
	finish(ports[0]!, 2);
	assert.ok(pool.predict(2).overhead > 50, "scan-like: the cold render was mostly decode");
	// Another page of the same document starts from what page 2 cost.
	assert.ok(pool.predict(7).overhead > 50);
});

test("a vector-like page (cost follows content) keeps no overhead", () => {
	const { pool, ports, finish, tile } = setup(1);
	tile("base", 4, 0, 1);
	pool.pump();
	finish(ports[0]!, 85);
	tile("t", 4, 10, 0.08);
	pool.pump();
	finish(ports[0]!, 7);
	assert.ok(pool.predict(4).overhead < 5);
	assert.ok(pool.predict(4).ms > 70);
});

test("a waiting visible job cancels an unwanted render even when another worker just took work", () => {
	const { pool, ports, tile } = setup(2);
	tile("old", 3, 30);
	pool.pump();
	assert.equal(ports[0]!.busy?.page, 3);
	pool.retain(new Set(["v1", "v2"]));
	tile("v1", 1, 10);
	tile("v2", 2, 10.1);
	pool.pump();
	assert.equal(ports[1]!.busy?.page, 1);
	assert.ok(ports[0]!.sent.some((m) => m.t === "cancel"));
});

test("page text never waits behind a busy worker while another is idle", () => {
	const { pool, ports, finish, tile, advance } = setup(2);
	// A scan: 60ms cold, 1ms per tile once loaded, so its tiles stay on the worker that has it.
	tile("base", 0, 0, 1);
	pool.pump();
	const [a, b] = ports;
	finish(a!, 60);
	tile("t1", 0, 10);
	pool.pump();
	finish(a!, 1);
	tile("t2", 0, 10);
	pool.pump();
	assert.equal(a!.busy?.page, 0);
	advance(0.5);
	pool.request("text:0", 20, { t: "text", page: 0 }, () => {});
	pool.pump();
	assert.equal(b!.sent.at(-1)?.t, "text", "the idle worker extracts the text instead of queueing behind the tile");
});

test("text cost is learned from what extraction took", () => {
	const { pool, ports } = setup(1);
	pool.request("text:3", 20, { t: "text", page: 3 }, () => {});
	pool.pump();
	const job = ports[0]!.busy!;
	ports[0]!.reply({ t: "text", id: job.id, page: 3, codes: new Uint32Array(0), boxes: new Float32Array(0), links: [], images: new Float32Array(0), scans: 1, size: { w: 1, h: 1 }, ms: 120, heap: 0 });
	assert.ok((pool as unknown as { textMs: number }).textMs > 30);
});

function trap(port: FakePort, recovered = true, kind: "trap" | "oom" = "trap") {
	const job = port.busy!;
	port.reply({ t: "error", message: "lector-engine: PDFium trap", code: "wasm-trap", phase: job.t === "text" ? "text" : "render", id: job.id, page: job.page, op: "FPDF_RenderPageBitmap", recovered, trap: kind });
	return job;
}

function trapSetup(n = 1, restartable = true) {
	const s = setup(n);
	const failed: { page: number; phase: string }[] = [];
	const errors: string[] = [];
	const restarts: { index: number; lowMemory: boolean }[] = [];
	const retired: number[] = [];
	const results = new Map<string, FromRaster["t"]>();
	s.pool.onPageFailed = (page, f) => failed.push({ page, phase: f.phase });
	s.pool.onError = (_m, code) => errors.push(code);
	if (restartable) s.pool.onRestart = (index, lowMemory) => restarts.push({ index, lowMemory });
	s.pool.onRetire = (index) => retired.push(index);
	const tile = (key: string, page: number, priority = 10) => s.pool.request(key, priority, { t: "tile", page, scale: 1, x: 0, y: 0, w: 512, h: 512 }, (res) => results.set(key, res.t), 1);
	/** the fresh worker the host starts for a restart, opened */
	const respawn = (index: number) => {
		const port = new FakePort();
		s.pool.replace(index, port as unknown as MessagePort);
		port.reply({ t: "opened", pageCount: 10, sizes: [], info: { pageCount: 10, encrypted: false, hasForm: false } });
		return port;
	};
	return { ...s, failed, errors, restarts, retired, results, tile, respawn };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

test("a job that crashed PDFium is retried once on the restarted worker", () => {
	const { pool, ports, finish, failed, errors, results, tile } = trapSetup();
	tile("a", 3);
	pool.pump();
	const first = trap(ports[0]!);
	assert.equal(ports[0]!.busy?.id, first.id, "the same job goes out again");
	finish(ports[0]!, 5);
	assert.equal(results.get("a"), "tile");
	assert.deepEqual(failed, []);
	assert.deepEqual(errors, []);
});

test("a page that crashes PDFium twice is skipped and its later jobs fail at once", async () => {
	const { pool, ports, failed, errors, results, tile } = trapSetup();
	tile("a", 3);
	tile("b", 3, 11);
	pool.pump();
	trap(ports[0]!);
	trap(ports[0]!);
	assert.deepEqual(failed, [{ page: 3, phase: "render" }]);
	assert.equal(results.get("a"), "error");
	assert.equal(results.get("b"), "error", "queued jobs of the page fail with it");
	assert.equal(pool.pending, 0);
	tile("c", 3);
	pool.request("text:3", 5, { t: "text", page: 3 }, (res) => results.set("text", res.t));
	assert.equal(pool.pending, 0, "never sent to a worker, text included");
	await flush();
	assert.equal(results.get("c"), "error");
	assert.equal(results.get("text"), "error");
	assert.deepEqual(errors, [], "the document keeps working");
	tile("d", 4);
	pool.pump();
	assert.equal(ports[0]!.busy?.page, 4);
});

test("crashes on many pages fail only those pages", () => {
	const { pool, ports, finish, failed, errors, results, tile } = trapSetup();
	for (let p = 0; p < 8; p++) {
		tile(`p${p}`, p);
		pool.pump();
		trap(ports[0]!);
		trap(ports[0]!);
	}
	assert.equal(failed.length, 8);
	assert.deepEqual(errors, []);
	tile("ok", 9);
	pool.pump();
	finish(ports[0]!, 5);
	assert.equal(results.get("ok"), "tile");
});

test("a page that renders after a retry gets a retry again next time", () => {
	const { pool, ports, finish, failed, tile } = trapSetup();
	tile("a", 3);
	pool.pump();
	trap(ports[0]!);
	finish(ports[0]!, 5);
	tile("b", 3);
	pool.pump();
	trap(ports[0]!);
	assert.equal(ports[0]!.busy?.page, 3, "retried, not skipped");
	assert.deepEqual(failed, []);
});

test("a tile that ran out of memory is retried at reduced resolution, and so are the page's later tiles", () => {
	const { pool, ports, finish, results, tile } = trapSetup();
	tile("a", 2);
	pool.pump();
	assert.equal(ports[0]!.busy?.reduce, undefined);
	trap(ports[0]!, true, "oom");
	assert.equal(ports[0]!.busy?.reduce, OOM_REDUCE);
	finish(ports[0]!, 5);
	assert.equal(results.get("a"), "tile");
	tile("b", 2);
	tile("c", 4, 11);
	pool.pump();
	assert.equal(ports[0]!.busy?.reduce, OOM_REDUCE);
	finish(ports[0]!, 5);
	assert.equal(ports[0]!.busy?.page, 4);
	assert.equal(ports[0]!.busy?.reduce, undefined, "other pages keep full resolution");
});

test("an ordinary render error (a refused bitmap, a pixel copy out of memory) fails the page, never the document", () => {
	const { pool, ports, failed, errors, tile } = trapSetup();
	tile("a", 5);
	pool.pump();
	const job = ports[0]!.busy!;
	ports[0]!.reply({ t: "error", message: "RangeError: Array buffer allocation failed", code: "unknown", phase: "render", id: job.id, page: 5, trap: "oom" });
	assert.equal(ports[0]!.busy?.reduce, OOM_REDUCE, "retried smaller on the same worker");
	const again = ports[0]!.busy!;
	ports[0]!.reply({ t: "error", message: "InvalidStateError: The ImageBitmap could not be allocated.", code: "unknown", phase: "render", id: again.id, page: 5 });
	assert.deepEqual(failed, [{ page: 5, phase: "render" }]);
	assert.deepEqual(errors, []);
});

test("a page whose text cannot be extracted still renders; its text is skipped from then on", async () => {
	const { pool, ports, finish, failed, errors, results, tile } = trapSetup();
	const text = (key: string) => pool.request("text:6", 5, { t: "text", page: 6 }, (res) => results.set(key, res.t));
	text("t1");
	pool.pump();
	trap(ports[0]!);
	trap(ports[0]!);
	assert.deepEqual(failed, [{ page: 6, phase: "text" }]);
	assert.equal(results.get("t1"), "error");
	text("t2");
	await flush();
	assert.equal(results.get("t2"), "error");
	tile("a", 6);
	pool.pump();
	finish(ports[0]!, 5);
	assert.equal(results.get("a"), "tile");
	assert.deepEqual(errors, []);
});

test("an outline that crashes PDFium answers empty without failing the document", () => {
	const { pool, ports, errors } = trapSetup();
	let got = "";
	pool.request("outline", 400, { t: "outline", page: -1 }, (res) => {
		got = res.t;
	});
	pool.pump();
	const job = ports[0]!.sent.at(-1) as Extract<ToRaster, { t: "outline" }>;
	ports[0]!.reply({ t: "error", message: "trap", code: "wasm-trap", phase: "render", id: job.id, recovered: true, trap: "trap" });
	assert.equal(got, "error");
	assert.deepEqual(errors, []);
});

test("a worker that could not restart PDFium is replaced by a fresh one, which gets the form edits and the page retry", () => {
	const { pool, ports, finish, errors, restarts, results, tile, respawn } = trapSetup(1);
	void pool.form({ page: 0, kind: "text", name: "f", value: "x" } as never);
	let opened = 0;
	pool.onOpened = () => opened++;
	tile("a", 1);
	pool.pump();
	trap(ports[0]!, false);
	assert.deepEqual(restarts, [{ index: 0, lowMemory: false }]);
	assert.deepEqual(errors, [], "not fatal");
	assert.equal(pool.workers, 1);
	const fresh = respawn(0);
	assert.equal(fresh.sent[0]?.t, "form", "edits replayed first");
	assert.equal((fresh.sent[0] as Extract<ToRaster, { t: "form" }>).report, false);
	assert.equal(fresh.busy?.page, 1, "the crashed page is retried there");
	finish(fresh, 5);
	assert.equal(results.get("a"), "tile");
	assert.equal(opened, 0, "the document is not reported open again");
});

test("a pending form report from a worker that is replaced settles empty", async () => {
	const { pool, ports, tile } = trapSetup(1);
	tile("a", 1);
	pool.pump();
	const edit = pool.form({ page: 0, kind: "text", name: "f", value: "x" } as never);
	trap(ports[0]!, false);
	assert.deepEqual(await edit, { changed: [], reset: false });
});

test("a form edit made while a worker restarts settles once the fresh worker replaces it", async () => {
	const { pool, ports, tile, respawn } = trapSetup(1);
	tile("a", 1);
	pool.pump();
	trap(ports[0]!, false);
	const edit = pool.form({ page: 0, kind: "text", name: "f", value: "x" } as never);
	const fresh = respawn(0);
	assert.deepEqual(await edit, { changed: [], reset: false });
	assert.equal(fresh.sent.filter((m) => m.t === "form").length, 1, "the edit reaches the fresh worker once");
});

test("a slot that keeps crashing retires after its restarts; with no worker left the document fails", () => {
	const { pool, ports, failed, errors, restarts, retired, tile, respawn } = trapSetup(1);
	tile("a", 1);
	pool.pump();
	trap(ports[0]!, false);
	let port = respawn(0);
	trap(port, false);
	assert.deepEqual(failed, [{ page: 1, phase: "render" }]);
	assert.equal(restarts.length, WORKER_RESTARTS);
	assert.deepEqual(errors, []);
	port = respawn(0);
	tile("b", 2);
	pool.pump();
	trap(port, false);
	assert.deepEqual(retired, [0]);
	assert.equal(pool.workers, 0);
	assert.deepEqual(errors, ["wasm-trap"]);
});

test("without a host that can restart workers, a broken worker retires and the rest carry on", () => {
	const { pool, ports, finish, errors, retired, results, tile } = trapSetup(2, false);
	let opened = 0;
	pool.onOpened = () => opened++;
	tile("a", 1);
	tile("b", 2, 11);
	pool.pump();
	const [first, second] = ports as [FakePort, FakePort];
	const crashed = trap(first, false);
	assert.deepEqual(retired, [0]);
	assert.deepEqual(errors, [], "even the first worker is not fatal");
	finish(second, 5);
	assert.equal(second.busy?.page, crashed.page);
	finish(second, 5);
	assert.equal(results.get(crashed.page === 1 ? "a" : "b"), "tile");
	assert.equal(opened, 0);
});

test("the document fails when the last worker could not restart PDFium", () => {
	const { pool, ports, errors, tile } = trapSetup(1, false);
	tile("a", 1);
	pool.pump();
	trap(ports[0]!, false);
	assert.deepEqual(errors, ["wasm-trap"]);
});

function bootSetup(n: number) {
	const ports = Array.from({ length: n }, () => new FakePort());
	const pool = new RasterPool(ports as unknown as MessagePort[]);
	const errors: string[] = [];
	const restarts: { index: number; lowMemory: boolean }[] = [];
	const retired: number[] = [];
	const opened: number[] = [];
	pool.onError = (_m, code) => errors.push(code);
	pool.onRestart = (index, lowMemory) => restarts.push({ index, lowMemory });
	pool.onRetire = (index) => retired.push(index);
	pool.onOpened = (pageCount) => opened.push(pageCount);
	const oom = (port: FakePort) => port.reply({ t: "error", message: "lector-engine: pdfium.wasm failed to load: WebAssembly.instantiate(): Out of memory", code: "wasm", phase: "engine-load", trap: "oom" });
	const open = (port: FakePort, pageCount = 10) => port.reply({ t: "opened", pageCount, sizes: [], info: { pageCount, encrypted: false, hasForm: false } });
	return { pool, ports, errors, restarts, retired, opened, oom, open };
}

test("PDFium memory that cannot be reserved at boot leaves fewer workers, never an error", () => {
	const { pool, ports, errors, retired, opened, oom, open } = bootSetup(3);
	oom(ports[2]!);
	assert.deepEqual(retired, [2]);
	oom(ports[0]!);
	assert.deepEqual(retired, [2, 0]);
	assert.deepEqual(opened, []);
	open(ports[1]!, 7);
	assert.deepEqual(opened, [7], "the first remaining worker reports the document");
	assert.deepEqual(errors, []);
	assert.equal(pool.workers, 1);
});

test("a worker that opened before the first retired reports the document then", () => {
	const { ports, retired, opened, oom, open } = bootSetup(2);
	open(ports[1]!, 4);
	assert.deepEqual(opened, []);
	oom(ports[0]!);
	assert.deepEqual(retired, [0]);
	assert.deepEqual(opened, [4]);
});

test("the last worker out of memory at boot retries with a smaller heap once, then the document fails", () => {
	const { pool, ports, errors, restarts, opened, oom, open } = bootSetup(1);
	oom(ports[0]!);
	assert.deepEqual(restarts, [{ index: 0, lowMemory: true }]);
	assert.deepEqual(errors, []);
	const fresh = new FakePort();
	pool.replace(0, fresh as unknown as MessagePort);
	open(fresh, 3);
	assert.deepEqual(opened, [3]);

	const other = bootSetup(1);
	other.oom(other.ports[0]!);
	const again = new FakePort();
	other.pool.replace(0, again as unknown as MessagePort);
	other.oom(again);
	assert.deepEqual(other.errors, ["wasm"], "the original code, as before");
});

test("a document that cannot be opened is still reported once, by the first worker", () => {
	const { ports, errors, retired } = bootSetup(2);
	const fail = (port: FakePort) => port.reply({ t: "error", message: "PDFium could not open the document (format)", code: "parse", phase: "document-load" });
	fail(ports[1]!);
	fail(ports[0]!);
	assert.deepEqual(errors, ["parse"]);
	assert.deepEqual(retired, []);
});
