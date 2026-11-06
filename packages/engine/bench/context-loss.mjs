// Loses the WebGL context (WEBGL_lose_context, or a real GPU-process crash) and checks the viewer continues on the 2D compositor, or errors with `compositor`.
//   URL=http://127.0.0.1:5199/ CHROME=/path/to/chrome node bench/context-loss.mjs
import { chromium } from "playwright-core";
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const base = process.env.URL ?? "http://127.0.0.1:5199/";
const cases = [
	{ name: "lose", fail2d: 0, want: "canvas2d" },
	{ name: "lose, first fresh 2D context refused", fail2d: 1, want: "canvas2d" },
	{ name: "lose, every fresh 2D context refused", fail2d: 99, want: "error:compositor" },
	{ name: "GPU process crash x3", crash: 3, fail2d: 0, want: "canvas2d" },
	{ name: "WebGL context lost at creation", lostAtStart: true, fail2d: 0, want: "canvas2d" },
];
// The viewer's own canvas (in the document) gets a context that is already lost; the support probe's detached canvases do not.
const loseAtStart = () => {
	const g = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (k, o) {
		const ctx = g.call(this, k, o);
		if (k === "webgl2" && ctx && this.isConnected && !window.__lostOnce) {
			window.__lostOnce = true;
			ctx.getExtension("WEBGL_lose_context")?.loseContext();
		}
		return ctx;
	};
};
const lose = "(self.__core ?? globalThis.__core).gl.gl.getExtension('WEBGL_lose_context').loseContext()";
// Fresh canvases are 300x150 until resized; tiles and scratch surfaces are other sizes.
const refuse2d = (cls, n) =>
	`(() => { let left = ${n}; const g = ${cls}.prototype.getContext; ${cls}.prototype.getContext = function (k, o) { if (k === "2d" && this.width === 300 && left > 0) { left--; return null; } return g.call(this, k, o); }; })()`;

let failed = 0;
for (const c of cases) {
	for (const offscreen of c.lostAtStart ? ["0"] : ["0", "1"]) {
		// A browser per run: GPU crashes add up and Chrome gives up on the GPU (or quits) after a few.
		const browser = await chromium.launch({ executablePath: exe, headless: process.env.HEADED !== "1" });
		const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
		if (c.lostAtStart) await page.addInitScript(loseAtStart);
		const opened = Date.now();
		try {
			await page.goto(`${base}?file=${process.env.FILE ?? "/text.pdf"}&compositor=webgl2&offscreen=${offscreen}`);
			await page.waitForFunction(() => window.__all?.some((e) => e.type === "painted"), null, { timeout: 30000 });
			await page.waitForTimeout(500);
			const inCore = async (js) => {
				if (offscreen === "0") return page.evaluate(js);
				for (const wk of page.workers()) if (await wk.evaluate(`(() => { if (!self.__core) return false; ${js}; return true; })()`).catch(() => false)) return;
				throw new Error("no compositor worker");
			};
			if (c.fail2d) await inCore(refuse2d(offscreen === "0" ? "HTMLCanvasElement" : "OffscreenCanvas", c.fail2d));
			const t0 = c.lostAtStart ? opened : Date.now();
			if (c.crash) {
				const cdp = await browser.newBrowserCDPSession();
				for (let i = 0; i < c.crash; i++) {
					await cdp.send("Browser.crashGpuProcess").catch(() => {});
					await page.waitForTimeout(300);
				}
			} else if (!c.lostAtStart) await inCore(lose);
			const done = await page
				.waitForFunction(() => window.__all.some((e) => e.type === "compositor" || e.type === "restored" || (e.type === "error" && e.code !== "gpu")), null, { timeout: 8000 })
				.then(() => true)
				.catch(() => false);
			const ms = Date.now() - t0;
			await page.waitForTimeout(800);
			const r = await page.evaluate(() => ({ comp: window.__viewer.compositor, events: window.__all.filter((e) => ["need-canvas", "compositor", "error", "restored"].includes(e.type)).map((e) => e.type + (e.code ? `:${e.code}` : "")) }));
			const got = r.events.includes("error:compositor") ? "error:compositor" : r.comp;
			const ok = done && got === c.want && ms < 2500;
			if (!ok) failed++;
			console.log(JSON.stringify({ case: c.name, offscreen, ok, ms, ...r }));
		} catch (err) {
			failed++;
			console.log(JSON.stringify({ case: c.name, offscreen, ok: false, error: String(err).split("\n")[0] }));
		}
		await browser.close().catch(() => {});
	}
}
process.exit(failed ? 1 : 0);
