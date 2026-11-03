// Slow-tile bench: raster p50/p95, time to first pixels and to sharp (open,
// jumps, reopen), blank frames while scrolling, frame p95 and memory peaks.
// Needs the demo on :5199 (or BASE=http://host:port) and the fixtures from bench/fixtures/make-heavy.mjs.
// Usage: node bench/tiles.mjs [file=/heavy-scan.pdf] [extra query]
//   TOUCH=1 emulates a phone (coarse pointer: 2 workers, 128MB textures); CPU=4 throttles the page.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const file = process.argv[2] ?? "/heavy-scan.pdf";
const extra = process.argv[3] ?? "";
const touch = process.env.TOUCH === "1";
const url = `${process.env.BASE ?? "http://127.0.0.1:5199"}/?file=${file}${extra}`;
const dir = mkdtempSync(join(tmpdir(), "lector-tiles-"));
const ctx = await chromium.launchPersistentContext(dir, {
	channel: "chrome",
	headless: process.env.HEADED !== "1",
	viewport: touch ? { width: 820, height: 1180 } : { width: 1280, height: 860 },
	deviceScaleFactor: 2,
	hasTouch: touch,
	isMobile: touch,
	args: ["--enable-gpu", "--use-angle=metal", "--disable-frame-rate-limit"],
});
const errors = [];
const pct = (xs, q) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const med = (xs) => pct(xs, 0.5);

async function openPage(more = "") {
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	page.removeAllListeners("pageerror");
	page.on("pageerror", (e) => errors.push(String(e)));
	if (process.env.CPU) {
		const cdp = await ctx.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU) });
	}
	const t0 = Date.now();
	await page.goto(url + more);
	await page.waitForFunction(() => window.__firstPaintMs !== undefined, null, { timeout: 120000 });
	return { page, t0 };
}

/** Evaluates `fn(core)` wherever the core lives (main thread or the compositor worker). */
let coreWorker = null;
async function inCore(page, fn, arg) {
	const run = ({ src, arg }) => new Function("core", "arg", `return (${src})(core, arg)`)(globalThis.__core, arg);
	if (coreWorker && !page.workers().includes(coreWorker)) coreWorker = null;
	if (!coreWorker) {
		if (await page.evaluate(() => !!globalThis.__core)) return page.evaluate(run, { src: fn.toString(), arg });
		// Asked in parallel: a raster worker answers only after its current job.
		coreWorker = await Promise.any(
			page.workers().map(async (w) => {
				if (!(await w.evaluate(() => !!self.__core))) throw new Error("not the core");
				return w;
			}),
		).catch(() => null);
		if (!coreWorker) return null;
	}
	return coreWorker.evaluate(run, { src: fn.toString(), arg });
}

const log = [];
const peaks = { workerMB: 0, textureMB: 0 };
async function probe(page) {
	const p = await inCore(page, (core) => core.debugProbe());
	if (!p) return null;
	log.push(...p.log);
	peaks.workerMB = Math.max(peaks.workerMB, p.workerMB);
	peaks.textureMB = Math.max(peaks.textureMB, p.textureMB);
	return p;
}

/** Polls until the view is drawn and sharp; ms since `start` for each. */
async function settle(page, start, timeout = 20000) {
	let drawnAt = null;
	let sharpAt = null;
	while (Date.now() - start < timeout) {
		const p = await probe(page);
		const t = Date.now() - start;
		if (p && drawnAt === null && p.drawn >= 0.999) drawnAt = t;
		if (p && p.sharp >= 0.999 && p.drawn >= 0.999) {
			sharpAt = t;
			break;
		}
		await page.waitForTimeout(8);
	}
	return { drawn: drawnAt ?? timeout, sharp: sharpAt ?? timeout };
}

const result = { file, touch, open: null, jumps: [], reopen: null };
{
	const { page, t0 } = await openPage();
	result.open = await settle(page, t0);
	const pageCount = await page.evaluate(() => window.__all.find((e) => e.type === "ready").pages.length);
	const targets = [0.35, 0.7, 0.15, 0.9].map((f) => Math.floor(f * (pageCount - 1)));
	for (const target of targets) {
		await page.waitForTimeout(400);
		const start = Date.now();
		await page.evaluate((p) => window.__viewer.goToPage(p, 0, { animate: false }), target);
		const from = log.length;
		if (process.env.TRACE) {
			await page.waitForTimeout(30);
			console.log("queue", (await inCore(page, (core) => core.pool.debugQueue())).slice(0, 40).join(" "));
		}
		result.jumps.push(await settle(page, start));
		if (process.env.TRACE) console.log(`jump ${target}`, JSON.stringify(result.jumps.at(-1)), log.slice(from).map((l) => `${l.page}${l.base ? "B" : "t"}:${l.ms.toFixed(0)}/${l.waitMs.toFixed(0)}`).join(" "));
	}
	// Steady scroll: 30 css px per frame, sampling what is on screen every frame.
	await page.evaluate(() => window.__viewer.goToPage(Math.floor(window.__all.find((e) => e.type === "ready").pages.length * 0.45), 0, { animate: false }));
	await page.waitForTimeout(1500);
	await probe(page);
	await page.evaluate(() => {
		window.__events.length = 0;
	});
	const frames = 240;
	let blank = 0;
	let blurry = 0;
	for (let i = 0; i < frames; i += 4) {
		await page.evaluate(async () => {
			const el = document.getElementById("viewer");
			for (let k = 0; k < 4; k++) {
				el.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
				await new Promise((r) => requestAnimationFrame(r));
			}
		});
		const p = await probe(page);
		if (p && p.drawn < 0.999) blank++;
		else if (p && p.sharp < 0.999) blurry++;
	}
	await page.waitForTimeout(700);
	const stats = await page.evaluate(() => window.__events.map((e) => e.stats).filter((s) => s.fps > 0));
	result.scroll = {
		samples: frames / 4,
		blankPct: (100 * blank) / (frames / 4),
		blurryPct: (100 * blurry) / (frames / 4),
		frameP95: Math.max(0, ...stats.map((s) => s.p95FrameMs)),
		fps: stats.length ? Math.min(...stats.map((s) => s.fps)) : 0,
	};
}
// Reopen where the reader left off, in the same browser profile, after a pause (a persistent tile cache would serve this).
{
	const last = await ctx.pages()[0].evaluate(() => window.__all.filter((e) => e.type === "view").at(-1)?.page ?? 0);
	await ctx.pages()[0].waitForTimeout(3000);
	const { page, t0 } = await openPage(`&page=${last}`);
	result.reopen = await settle(page, t0);
}
const base = log.filter((l) => l.base).map((l) => l.ms);
const sharp = log.filter((l) => !l.base).map((l) => l.ms);
const all = log.map((l) => l.ms);
result.raster = { n: all.length, p50: med(all), p95: pct(all, 0.95), baseP50: med(base), baseP95: pct(base, 0.95), tileP50: med(sharp), tileP95: pct(sharp, 0.95), waitP95: pct(log.map((l) => l.waitMs), 0.95) };
result.peaks = peaks;
result.errors = errors;
const f = (n) => (typeof n === "number" ? n.toFixed(0) : n);
console.log(
	`${file}${extra}${touch ? " [touch]" : ""}\n` +
		`  raster      p50 ${f(result.raster.p50)}ms  p95 ${f(result.raster.p95)}ms  (base p50/p95 ${f(result.raster.baseP50)}/${f(result.raster.baseP95)}, tiles ${f(result.raster.tileP50)}/${f(result.raster.tileP95)}, wait p95 ${f(result.raster.waitP95)}ms, n=${result.raster.n})\n` +
		`  open        drawn ${f(result.open.drawn)}ms  sharp ${f(result.open.sharp)}ms\n` +
		`  jumps       drawn med ${f(med(result.jumps.map((j) => j.drawn)))}ms max ${f(Math.max(...result.jumps.map((j) => j.drawn)))}ms  sharp med ${f(med(result.jumps.map((j) => j.sharp)))}ms max ${f(Math.max(...result.jumps.map((j) => j.sharp)))}ms\n` +
		`  scroll      blank ${f(result.scroll.blankPct)}%  blurry ${f(result.scroll.blurryPct)}%  frame p95 ${result.scroll.frameP95.toFixed(1)}ms  fps(min) ${f(result.scroll.fps)}\n` +
		`  reopen      drawn ${f(result.reopen.drawn)}ms  sharp ${f(result.reopen.sharp)}ms\n` +
		`  peaks       PDFium workers ${f(peaks.workerMB)}MB  GPU ${f(peaks.textureMB)}MB${errors.length ? `\n  ERRORS ${errors.join(" | ")}` : ""}`,
);
if (process.env.JSON) console.log(JSON.stringify(result));
await ctx.close();
rmSync(dir, { recursive: true, force: true });
