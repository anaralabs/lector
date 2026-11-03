// Citation-jump benchmark on a long PDF: per-frame cost while the camera flies,
// raster jobs and memory per jump, and steady-state scroll frames for contrast.
// Usage: node bench/jumps.mjs [url] [label]   (THROTTLE=4 slows the CPU, GPU=swiftshader)
// FEATURES=on|off sets every flight polish option (FLIGHT_PATH=glide|zoom-out); PREFETCH=1 hovers before each jump.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:5199/";
const label = process.argv[3] ?? "";
const features = process.env.FEATURES ?? "off";
const throttle = Number(process.env.THROTTLE ?? 1);
const gpuArgs = process.env.GPU === "swiftshader" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--enable-gpu", "--use-angle=metal"];
const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADED !== "1", args: [...gpuArgs, "--disable-frame-rate-limit"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const file = process.env.FILE ?? "/long.pdf";
await page.goto(`${base}?file=${file}`);
await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 60000 });
await page.waitForTimeout(1500);
if (throttle > 1) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
}

let core = null;
for (const w of page.workers()) if (await w.evaluate(() => !!self.__core).catch(() => false)) core = w;
if (!core) throw new Error("no compositor worker (run with the offscreen compositor)");
const on = features === "on";
await page.evaluate(
	({ on, blur, path }) => window.__viewer.setOptions({ flightPath: on ? path : "cut", flightMotionBlur: on && blur, flightCarryVelocity: on }),
	{ on, blur: process.env.BLUR !== "0", path: process.env.FLIGHT_PATH ?? "glide" },
);

// Records every frame the core actually draws, and every tile job sent to a raster worker.
await core.evaluate(() => {
	const c = self.__core;
	self.__frames = [];
	self.__tileJobs = 0;
	self.__gpuPeak = 0;
	const frame = c.frame.bind(c);
	c.frame = (now) => {
		const id = c.frameId;
		const t0 = performance.now();
		frame(now);
		if (c.frameId === id) return;
		const gpu = c.gl.textureBytes + (c.gl.blurBytes ?? 0);
		if (gpu > self.__gpuPeak) self.__gpuPeak = gpu;
		self.__frames.push({ now, cpu: performance.now() - t0, flight: !!c.flight, blur: !!c.blurOn });
	};
	for (const lane of c.pool.lanes) {
		const post = lane.port.postMessage.bind(lane.port);
		lane.port.postMessage = (m, t) => {
			if (m?.t === "tile") {
				self.__tileJobs++;
				(self.__keys ??= []).push(`${m.page}:${m.scale}:${m.x}:${m.y}`);
			}
			return post(m, t);
		};
	}
});
const reset = () => core.evaluate(() => {
	self.__frames = [];
	self.__tileJobs = 0;
	self.__gpuPeak = 0;
	self.__keys = [];
});
const collect = () => core.evaluate(() => ({ frames: self.__frames, tileJobs: self.__tileJobs, gpuPeak: self.__gpuPeak, workerMB: self.__core.pool.heapBytes / 1048576, keys: self.__keys ?? [] }));
const q = (xs, p) => {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const intervals = (frames, pick) => {
	const out = [];
	for (let i = 1; i < frames.length; i++) if (pick(frames[i]) && pick(frames[i - 1])) out.push(frames[i].now - frames[i - 1].now);
	return out;
};

const targets = await page.evaluate(async () => {
	const v = window.__viewer;
	const n = (await v.loaded).pages.length;
	const want = [0, 1, 3, 40, 120, 2, 60].filter((p) => p < n);
	const out = {};
	for (const p of want) {
		const rects = await v.rects(p, 200, 420);
		const x0 = Math.min(...rects.map((r) => r.x));
		const y0 = Math.min(...rects.map((r) => r.y));
		const x1 = Math.max(...rects.map((r) => r.x + r.w));
		const y1 = Math.max(...rects.map((r) => r.y + r.h));
		out[p] = { page: p, rects, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
	}
	return out;
});

const rows = [];
const jump = async (name, t) => {
	await page.waitForTimeout(500);
	await reset();
	const r = await page.evaluate(
		async ({ t, name, prefetch }) => {
			const v = window.__viewer;
			v.setHighlights([{ id: name, page: t.page, rects: t.rects, color: [0.35, 0.6, 1, 0.45], interactive: false }]);
			if (prefetch && v.prefetch) {
				v.prefetch(t.page, t.rect);
				await new Promise((r) => setTimeout(r, 350));
			}
			const landed = await v.reveal(t.page, t.rect, { animate: true });
			const f = window.__flights.at(-1);
			await new Promise((r) => setTimeout(r, 1000));
			return { landed, waitMs: f.waitMs, durationMs: f.durationMs, coverage: f.coverage };
		},
		{ t, name, prefetch: process.env.PREFETCH === "1" },
	);
	const c = await collect();
	if (process.env.KEYS === "1") console.log(name, c.keys.join(" "));
	const fl = c.frames.filter((f) => f.flight);
	const iv = intervals(c.frames, (f) => f.flight);
	const cpu = fl.map((f) => f.cpu);
	rows.push({
		name,
		landed: r.landed,
		waitMs: r.waitMs,
		durMs: r.durationMs,
		cov: r.coverage,
		frames: fl.length,
		p50: q(iv, 0.5),
		p95: q(iv, 0.95),
		worst: Math.max(0, ...iv),
		cpuP95: q(cpu, 0.95),
		blurFrames: fl.filter((f) => f.blur).length,
		tiles: c.tileJobs,
		gpuMB: c.gpuPeak / 1048576,
		workerMB: c.workerMB,
	});
};

await page.evaluate(() => window.__viewer.fitWidth());
await jump("short p1->p2", targets[1]);
await jump("medium p2->p4", targets[3]);
if (targets[40]) await jump("long p4->p41", targets[40]);
if (targets[120]) await jump("far p41->p121", targets[120]);
if (targets[120]) await jump("far back p121->p3", targets[2]);
if (targets[60]) {
	await page.evaluate(() => window.__viewer.zoomTo(2.4));
	await page.waitForTimeout(800);
	await jump("zoomed p3->p61", targets[60]);
	await page.evaluate(() => window.__viewer.fitWidth());
}
// Retarget: a second jump 150ms into the first.
await page.waitForTimeout(500);
await reset();
const retarget = await page.evaluate(async ({ a, b }) => {
	const v = window.__viewer;
	const first = v.reveal(a.page, a.rect, { animate: true });
	await new Promise((r) => setTimeout(r, 150));
	const second = await v.reveal(b.page, b.rect, { animate: true });
	return [await first, second];
}, { a: targets[40] ?? targets[3], b: targets[2] });
{
	const c = await collect();
	const iv = intervals(c.frames, (f) => f.flight);
	rows.push({ name: "retarget mid-flight", landed: retarget.join("/"), waitMs: NaN, durMs: NaN, cov: NaN, frames: c.frames.filter((f) => f.flight).length, p50: q(iv, 0.5), p95: q(iv, 0.95), worst: Math.max(0, ...iv), cpuP95: q(c.frames.map((f) => f.cpu), 0.95), blurFrames: c.frames.filter((f) => f.blur).length, tiles: c.tileJobs, gpuMB: c.gpuPeak / 1048576, workerMB: c.workerMB });
}

// Steady-state scroll: wheel input every frame, no flight.
await page.evaluate(() => window.__viewer.goToPage(5));
await page.waitForTimeout(800);
await reset();
await page.evaluate(async () => {
	const el = document.getElementById("viewer");
	for (let i = 0; i < 240; i++) {
		el.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, clientX: 640, clientY: 430, bubbles: true, cancelable: true }));
		await new Promise((r) => requestAnimationFrame(r));
	}
	await new Promise((r) => setTimeout(r, 300));
});
const scroll = await collect();
const siv = intervals(scroll.frames, () => true);
const scpu = scroll.frames.map((f) => f.cpu);

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
console.log(`\n${label} features=${features} path=${process.env.FLIGHT_PATH ?? "glide"} blur=${process.env.BLUR !== "0"} throttle=${throttle}x gpu=${process.env.GPU ?? "metal"} prefetch=${process.env.PREFETCH === "1"}`);
console.log("| jump | landed | wait ms | flight ms | frames | p50 ms | p95 ms | worst ms | cpu p95 ms | blur frames | tile jobs | GPU MB peak | worker MB | coverage |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.landed} | ${f1(r.waitMs)} | ${f1(r.durMs)} | ${r.frames} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.worst)} | ${r.cpuP95.toFixed(2)} | ${r.blurFrames} | ${r.tiles} | ${r.gpuMB.toFixed(0)} | ${r.workerMB.toFixed(0)} | ${Number.isFinite(r.cov) ? (r.cov * 100).toFixed(0) + "%" : "-"} |`);
console.log(`| steady scroll (240 frames) | | | | ${scroll.frames.length} | ${f1(q(siv, 0.5))} | ${f1(q(siv, 0.95))} | ${f1(Math.max(...siv))} | ${q(scpu, 0.95).toFixed(2)} | 0 | ${scroll.tileJobs} | ${(scroll.gpuPeak / 1048576).toFixed(0)} | ${scroll.workerMB.toFixed(0)} | |`);
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no errors");
await browser.close();
