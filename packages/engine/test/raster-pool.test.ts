import assert from "node:assert/strict";
import { test } from "node:test";
import type { FromRaster, ToRaster } from "../src/protocol.ts";
import { RasterPool, rasterWorkerCount } from "../src/raster-pool.ts";

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
