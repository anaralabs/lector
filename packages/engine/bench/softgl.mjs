// Software-rendering bench: frame times of each compositor on a GPU-less box, per gesture.
// Usage: node bench/softgl.mjs [dpr] [files,comma] [modes,comma]; DARK=1 dark mode, UNCAPPED=1 no vsync cap, HZ=240 faster input (same gesture speed).
// HEADED=1 presents to a display (run under xvfb-run): headless skips the browser's own compositing, which is most of a software frame.
import { chromium } from "playwright-core";

const base = process.env.URL ?? "http://127.0.0.1:5199/";
const dpr = Number(process.argv[2] ?? 1);
const files = (process.argv[3] ?? "text.pdf,heavy-vector.pdf,heavy-scan.pdf").split(",");
const modes = (process.argv[4] ?? "gl-swiftshader,2d-nogpu").split(",");
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const uncapped = process.env.UNCAPPED === "1" ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : [];
const MODE = {
	"gl-swiftshader": { args: [], compositor: "webgl2" },
	"2d-swiftshader": { args: [], compositor: "canvas2d" },
	"2d-nogpu": { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2"], compositor: "auto" },
};
const extra = (process.env.DARK === "1" ? "&dark=1" : "") + (process.env.Q ?? "");
const hz = Number(process.env.HZ ?? 120);
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);

for (const mode of modes) {
	const m = MODE[mode];
	const browser = await chromium.launch({ executablePath: exe, headless: process.env.HEADED !== "1", args: [...m.args, ...uncapped] });
	for (const file of files) {
		const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: dpr });
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e)));
		page.on("console", (msg) => msg.type() === "error" && !msg.text().includes("404") && errors.push(msg.text()));
		await page.goto(`${base}?file=/${file}&compositor=${m.compositor}${extra}`);
		await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 60000 });
		const painted = await page.evaluate(() => window.__paintedMs);
		await page.waitForTimeout(1500);
		// The core runs on the main thread or in the compositor worker.
		let home = null;
		const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(undefined), 3000))]);
		const core = async (expr) => {
			if (home) return within(home.evaluate(`(${expr})`).catch(() => undefined));
			if (await page.evaluate("!!globalThis.__core")) home = page;
			else for (const w of page.workers()) if (await within(w.evaluate("!!self.__core").catch(() => false))) home = w;
			return home ? within(home.evaluate(`(${expr})`).catch(() => undefined)) : undefined;
		};
		const drive = async (frames, step) => {
			await core("(__core.debugFrames = [], __core.debugWork = [], 1)");
			const r = await page.evaluate(
				async ({ frames, step, hz }) => {
					const el = document.getElementById("viewer");
					const fn = new Function("i", "el", "wheel", "k", step);
					const wheel = (dx, dy, ctrl, x = 640, y = 430) =>
						el.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, ctrlKey: ctrl, clientX: x, clientY: y, bubbles: true, cancelable: true }));
					window.__events.length = 0;
					const t0 = performance.now();
					// Input at a fixed rate, so every compositor gets the same gesture whatever its frame rate.
					const k = 120 / hz;
					for (let i = 0; i < frames / k; i++) {
						fn(i * k, el, wheel, k);
						const next = t0 + (i + 1) * (1000 / hz);
						while (performance.now() < next - 1) await new Promise((r) => setTimeout(r, Math.max(0, next - performance.now() - 1)));
					}
					return { ms: performance.now() - t0, stats: window.__events.map((e) => e.stats) };
				},
				{ frames, step, hz },
			);
			const ends = (await core("__core.debugFrames.splice(0)")) ?? [];
			const work = (await core("__core.debugWork.splice(0)")) ?? [];
			// Only frames that moved the camera, back to back: a gesture past min/max zoom changes nothing.
			const gaps = [];
			for (let i = 1; i < ends.length; i++) if (ends[i] > 0 && ends[i - 1] > 0) gaps.push(ends[i] - ends[i - 1]);
			const ft = gaps.filter((d) => d < 250).sort((a, b) => a - b);
			await core("(__core.debugFrames = null, __core.debugWork = null, 1)");
			await page.waitForTimeout(700);
			const cpu = r.stats.map((s) => s.avgCpuMs).filter((x) => x > 0);
			const tiles = r.stats.map((s) => s.avgTileMs).filter((x) => x > 0);
			return {
				fps: +((ends.filter((t) => t > 0).length * 1000) / r.ms).toFixed(1),
				p50: +pct(ft, 0.5).toFixed(1),
				p95: +pct(ft, 0.95).toFixed(1),
				max: +(ft.at(-1) ?? 0).toFixed(0),
				drops: +((100 * gaps.filter((g) => g > 25).length) / Math.max(1, gaps.length)).toFixed(1),
				cpu: +(cpu.length ? Math.max(...cpu) : 0).toFixed(1),
				tileMs: +(tiles.length ? tiles.reduce((a, b) => a + b, 0) / tiles.length : 0).toFixed(1),
				gpuMB: +Math.max(0, ...r.stats.map((s) => s.textureMB)).toFixed(0),
				workerMB: +Math.max(0, ...r.stats.map((s) => s.workerMB)).toFixed(0),
				// p95 of the compositor thread's time in frame() and right after it (commit, queued tile messages)
				frameP95: +pct(work.map((w) => w[0]).sort((a, b) => a - b), 0.95).toFixed(1),
				afterP95: +pct(work.map((w) => w[1]).sort((a, b) => a - b), 0.95).toFixed(1),
				rasterScale: Math.min(9, ...r.stats.map((s) => s.rasterScale ?? 9)),
				adaptive: r.stats.some((s) => s.adaptive),
			};
		};
		const scroll = await drive(360, "wheel(0, 15 * k, false)");
		const fling = await drive(360, "wheel(0, Math.max(0, 90 - (i % 90)) * k, false)");
		const zoom = await drive(240, "wheel(0, -3 * k, true, 400, 300)");
		await page.waitForTimeout(800);
		const pan = await drive(360, "wheel(Math.sin(i/40)*10*k, 12 * k, false)");
		const zoomOut = await drive(240, "wheel(0, 4 * k, true)");
		const comp = await page.evaluate(() => window.__viewer.compositor);
		await page.screenshot({ path: `/tmp/softgl-${mode}-${file}-${dpr}${extra ? "-x" : ""}.png` });
		console.log(JSON.stringify({ mode, comp, file, dpr, dark: process.env.DARK === "1", uncapped: !!uncapped.length, painted: Math.round(painted), scroll, fling, zoom, pan, zoomOut, errors: errors.slice(0, 2) }));
		await page.close();
	}
	await browser.close();
}
