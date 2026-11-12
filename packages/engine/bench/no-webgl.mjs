// Browsers without a usable WebGL2, and compositors that fail to start: the document opens on Canvas 2D (worker or main thread), with highlights, selection, zoom and flights.
//   URL=http://127.0.0.1:5199/ CHROME=/path/to/chrome node bench/no-webgl.mjs
import { chromium } from "playwright-core";

const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const base = process.env.URL ?? "http://127.0.0.1:5199/";
const NO_WEBGL = ["--disable-webgl", "--disable-webgl2"];

// A transferred canvas is 300x150 until the core sizes it; tiles and scratch surfaces are other sizes.
const refuse2dOffscreen = `{ const g = OffscreenCanvas.prototype.getContext; OffscreenCanvas.prototype.getContext = function (k, o) { return k === "2d" && this.width === 300 && this.height === 150 ? null : g.call(this, k, o); }; }`;
const refuseFirst2dOnPage = () => {
	const g = HTMLCanvasElement.prototype.getContext;
	let left = 1;
	HTMLCanvasElement.prototype.getContext = function (k, o) {
		if (k === "2d" && this.isConnected && left > 0) {
			left--;
			return null;
		}
		return g.call(this, k, o);
	};
};
// The probe sees a hardware GPU (so `auto` picks WebGL2) ...
const hardwareRenderer = () => {
	const g = WebGL2RenderingContext.prototype.getParameter;
	WebGL2RenderingContext.prototype.getParameter = function (p) {
		return p === 0x9246 ? "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)" : g.call(this, p);
	};
};
// ... whose shaders then fail to compile in the compositor worker, after WebGL2 took its canvas.
const brokenShaders = `{ WebGL2RenderingContext.prototype.getShaderParameter = function () { return false; }; }`;

const cases = [
	{ name: "--disable-webgl", args: NO_WEBGL, offscreen: ["1", "0"], want: { offscreen: { 1: true, 0: false } } },
	{ name: "--disable-gpu --disable-webgl", args: ["--disable-gpu", ...NO_WEBGL], offscreen: ["1", "0"], want: { offscreen: { 1: true, 0: false } } },
	{ name: "--use-gl=disabled", args: ["--use-gl=disabled", ...NO_WEBGL], offscreen: ["1"], want: { offscreen: { 1: true } } },
	{ name: "no 2D on the worker's OffscreenCanvas", args: NO_WEBGL, offscreen: ["1"], worker: refuse2dOffscreen, want: { offscreen: { 1: false } } },
	{ name: "first main-thread canvas refuses 2D", args: NO_WEBGL, offscreen: ["0"], init: refuseFirst2dOnPage, want: { offscreen: { 0: false } } },
	{ name: "WebGL2 takes the canvas, then its shaders fail", args: [], offscreen: ["1"], init: hardwareRenderer, worker: brokenShaders, want: { offscreen: { 1: false } } },
];

let failed = 0;
for (const c of cases) {
	for (const offscreen of c.offscreen) {
		const browser = await chromium.launch({ executablePath: exe, headless: true, args: c.args });
		const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
		if (c.init) await page.addInitScript(c.init);
		if (c.worker)
			await page.route(/core-worker/, async (route) => {
				const res = await route.fetch();
				await route.fulfill({ response: res, body: `${c.worker}\n${await res.text()}` });
			});
		const r = { case: c.name, offscreen };
		try {
			await page.goto(`${base}?file=/text.pdf&compositor=auto&offscreen=${offscreen}&page=1`);
			await page.waitForFunction(() => window.__paintedMs !== undefined || window.__errors?.length, null, { timeout: 30000 });
			Object.assign(r, await page.evaluate(() => ({ compositor: window.__viewer?.compositor, workerCore: window.__viewer?.offscreen, errors: window.__errors.map((e) => `${e.code}: ${e.message}`.slice(0, 160)) })));
			await page.evaluate(() => {
				document.getElementById("hud").style.display = "none";
				window.__viewer.setHighlights([{ id: "a", page: 1, rects: [{ x: 110, y: 120, w: 380, h: 30 }], color: [1, 0.85, 0.2, 0.6] }]);
			});
			await page.waitForTimeout(1500);
			await page.mouse.move(300, 420);
			await page.mouse.down();
			for (let i = 1; i <= 20; i++) await page.mouse.move(300 + i * 15, 420 + i * 3);
			await page.mouse.up();
			await page.waitForTimeout(800);
			const shot = await page.screenshot();
			r.selected = await page.evaluate(() => window.__all.filter((e) => e.type === "selection" && e.final).at(-1)?.selection?.text?.length ?? 0);
			Object.assign(r, await pixels(page, shot));
			r.flight = await page.evaluate(() => window.__viewer.reveal(3, { x: 100, y: 100, w: 200, h: 20 }, { animate: true }));
			await page.evaluate(() => window.__viewer.zoomTo(2));
			await page.waitForTimeout(1500);
			r.zoomedInk = (await pixels(page, await page.screenshot())).ink;
			const w = c.want;
			r.ok = r.compositor === "canvas2d" && r.workerCore === w.offscreen[offscreen] && r.errors.length === 0 && r.ink > 2000 && r.highlight > 2000 && r.selected > 0 && r.flight === true && r.zoomedInk > 2000 && errors.length === 0;
		} catch (err) {
			r.ok = false;
			r.error = String(err).split("\n")[0];
		}
		r.pageErrors = errors.slice(0, 2);
		if (!r.ok) failed++;
		console.log(JSON.stringify(r));
		await browser.close().catch(() => {});
	}
}
process.exit(failed ? 1 : 0);

/** dark text pixels and highlight-yellow pixels in a screenshot */
async function pixels(page, png) {
	return page.evaluate(async (b64) => {
		const i = new Image();
		i.src = `data:image/png;base64,${b64}`;
		await i.decode();
		const c = new OffscreenCanvas(i.width, i.height);
		const x = c.getContext("2d");
		x.drawImage(i, 0, 0);
		const d = x.getImageData(0, 0, i.width, i.height).data;
		let ink = 0;
		let highlight = 0;
		for (let p = 0; p < d.length; p += 4) {
			if (d[p] < 90 && d[p + 1] < 90 && d[p + 2] < 90) ink++;
			if (d[p] > 200 && d[p + 1] > 170 && d[p + 2] < 160) highlight++;
		}
		return { ink, highlight };
	}, png.toString("base64"));
}
