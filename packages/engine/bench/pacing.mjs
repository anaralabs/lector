// Frame pacing on a long document under CPU throttling: dropped frames, uncapped
// worst frames, per-frame upload peaks and time-to-sharp after zooms and jumps.
// Input is dispatched every animation frame at the display's real refresh rate.
// Usage: node bench/pacing.mjs [url] [--runs N] [--throttle N] [--json out.json] [--trace out.json]
// The default url opens demo/public/big.pdf (node bench/fixtures/make-big.mjs 12).
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};
const url = argv[0] && !argv[0].startsWith("--") ? argv[0] : "http://127.0.0.1:5199/?file=/big.pdf";
const runs = Number(flag("runs", 3));
const throttle = Number(flag("throttle", 4));
const jsonOut = flag("json");
const traceOut = flag("trace");

// Each scenario gets a fresh browser: this sandbox kills Chrome after ~30s.
const scenarios = [
	{ name: "scroll", query: "", frames: 480, step: "wheel(0, 45, false)" },
	{ name: "fast scroll", query: "", frames: 300, step: "wheel(0, 160, false)" },
	{ name: "pinch in", query: "", frames: 120, step: "wheel(0, -6, true, 500, 400)" },
	{ name: "scroll zoomed", query: "&zoom=2.5", frames: 360, step: "wheel(Math.sin(i/25)*25, 40, false)" },
	{ name: "pinch out", query: "&zoom=3&page=20", frames: 120, step: "wheel(0, 6, true, 500, 400)" },
];

const median = (xs) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function open(query, trace) {
	const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADED !== "1", args: ["--enable-gpu", "--use-angle=metal"] });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	const cdp = await page.context().newCDPSession(page);
	await page.goto(url + query);
	await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 20000 });
	await page.waitForTimeout(1500);
	if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
	if (trace) {
		await cdp.send("Tracing.start", {
			transferMode: "ReturnAsStream",
			traceConfig: {
				includedCategories: [
					"devtools.timeline",
					"disabled-by-default-devtools.timeline",
					"disabled-by-default-devtools.timeline.frame",
					"v8.gc",
					"gpu",
					"disabled-by-default-gpu.service",
					"viz",
					"toplevel",
				],
			},
		});
	}
	const close = async () => {
		if (trace) {
			const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
			await cdp.send("Tracing.end");
			const { stream } = await done;
			let data = "";
			for (;;) {
				const chunk = await cdp.send("IO.read", { handle: stream });
				data += chunk.data;
				if (chunk.eof) break;
			}
			writeFileSync(trace, data);
		}
		await browser.close();
		return errors;
	};
	return { page, close };
}

async function run(index) {
	const result = { scenarios: {}, errors: [] };
	for (const s of scenarios) {
		const { page, close } = await open(s.query, index === 0 && s.name === "scroll" ? traceOut : undefined);
		const windows = await page.evaluate(
			async ({ frames, step }) => {
				const el = document.getElementById("viewer");
				const fn = new Function("i", "el", "wheel", step);
				const wheel = (dx, dy, ctrl, x = 640, y = 430) =>
					el.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, ctrlKey: ctrl, clientX: x, clientY: y, bubbles: true, cancelable: true }));
				window.__events.length = 0;
				for (let i = 0; i < frames; i++) {
					fn(i, el, wheel);
					await new Promise((r) => requestAnimationFrame(r));
				}
				await new Promise((r) => setTimeout(r, 1200));
				return window.__events.map((e) => e.stats);
			},
			{ frames: s.frames, step: s.step },
		);
		if (index === 0 && s.name === "scroll") result.load = await page.evaluate(() => window.__all.find((e) => e.type === "load")?.timings);
		result.errors.push(...(await close()));
		const busy = windows.filter((w) => w.frames > 0);
		const sum = (k) => busy.reduce((a, w) => a + (w[k] ?? 0), 0);
		result.scenarios[s.name] = {
			frames: sum("frames"),
			fps: median(busy.filter((w) => w.fps > 0).map((w) => w.fps)),
			p95Median: median(busy.filter((w) => w.fps > 0).map((w) => w.p95FrameMs)),
			p95Max: Math.max(0, ...busy.map((w) => w.p95FrameMs)),
			worst: Math.max(0, ...busy.map((w) => w.worstFrameMs)),
			over33: sum("framesOver33"),
			over50: sum("framesOver50"),
			over100: sum("framesOver100"),
			cpu: median(busy.map((w) => w.avgCpuMs)),
			uploadPeakMB: Math.max(0, ...busy.map((w) => w.uploadPeakBytes ?? 0)) / 1048576,
			textureMB: Math.max(0, ...busy.map((w) => w.textureMB)),
		};
	}
	// Jumps across the document and zoom steps; each waits for the view to sharpen.
	const { page, close } = await open("");
	const sharp = await page.evaluate(async () => {
		const v = window.__viewer;
		const out = { jump: [], zoom: [] };
		const next = async (cause, act) => {
			const n = window.__all.length;
			await act();
			await new Promise((r) => setTimeout(r, 1300));
			const e = window.__all.slice(n).find((x) => x.type === "sharp" && x.cause === cause);
			if (e) out[cause].push(e.ms);
		};
		for (const p of [40, 200, 12, 290, 150, 5, 260, 90]) await next("jump", () => v.goToPage(p, 0, { animate: true }));
		for (const z of [2, 1, 3, 1.5]) await next("zoom", () => v.zoomTo(z));
		return out;
	});
	result.errors.push(...(await close()));
	result.sharp = { jumpMedian: median(sharp.jump), jumpMax: Math.max(0, ...sharp.jump), jumps: sharp.jump.length, zoomMedian: median(sharp.zoom), zoomMax: Math.max(0, ...sharp.zoom), zooms: sharp.zoom.length };
	return result;
}

const all = [];
for (let i = 0; i < runs; i++) all.push(await run(i));

const pick = (fn) => median(all.map(fn));
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
console.log(`throttle ${throttle}x, ${runs} runs (medians)  ${url}`);
console.log("scenario".padEnd(16), "frames  fps   p95med  p95max  worst   >33  >50  >100  cpu   upload MB");
const summary = { throttle, runs, url, scenarios: {}, sharp: {} };
for (const s of scenarios) {
	const m = (k) => pick((r) => r.scenarios[s.name][k]);
	const row = Object.fromEntries(["frames", "fps", "p95Median", "p95Max", "worst", "over33", "over50", "over100", "cpu", "uploadPeakMB", "textureMB"].map((k) => [k, m(k)]));
	summary.scenarios[s.name] = row;
	console.log(
		s.name.padEnd(16),
		String(row.frames).padStart(6),
		fmt(row.fps, 0).padStart(4),
		fmt(row.p95Median).padStart(7),
		fmt(row.p95Max).padStart(7),
		fmt(row.worst).padStart(7),
		String(row.over33).padStart(5),
		String(row.over50).padStart(4),
		String(row.over100).padStart(5),
		fmt(row.cpu, 2).padStart(5),
		fmt(row.uploadPeakMB, 1).padStart(8),
	);
}
for (const k of ["jumpMedian", "jumpMax", "zoomMedian", "zoomMax"]) summary.sharp[k] = pick((r) => r.sharp[k]);
console.log(`time-to-sharp  jump ${fmt(summary.sharp.jumpMedian, 0)}ms (max ${fmt(summary.sharp.jumpMax, 0)})  zoom ${fmt(summary.sharp.zoomMedian, 0)}ms (max ${fmt(summary.sharp.zoomMax, 0)})`);
console.log("load", JSON.stringify(all[0].load));
const errors = all.flatMap((r) => r.errors);
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, runs: all }, null, 2));
