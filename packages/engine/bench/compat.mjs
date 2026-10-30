// Degradation checks against the demo: emulates older browsers by removing
// APIs before the page loads, then checks which compositor path runs, or that
// createViewer rejects with a clear error instead of half-working.
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const supportModule = `/@fs${fileURLToPath(new URL("../src/support.ts", import.meta.url))}`;
const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--use-angle=metal"] });

const cases = [
	{ name: "modern", init: () => {}, expect: { offscreen: true } },
	{ name: "?offscreen=0 (forced main thread)", query: "offscreen=0", init: () => {}, expect: { offscreen: false } },
	{
		// Safari 15-16.3
		name: "no OffscreenCanvas",
		init: () => {
			delete HTMLCanvasElement.prototype.transferControlToOffscreen;
			delete globalThis.OffscreenCanvas;
		},
		expect: { offscreen: false },
	},
	{
		// Safari 16.4-16.x: OffscreenCanvas exists, WebGL on it does not
		name: "OffscreenCanvas without WebGL",
		init: () => {
			const get = OffscreenCanvas.prototype.getContext;
			OffscreenCanvas.prototype.getContext = function (type, ...rest) {
				return type === "webgl2" || type === "webgl" ? null : get.call(this, type, ...rest);
			};
		},
		expect: { offscreen: false },
	},
	{
		name: "no WebGL2",
		init: () => {
			const get = HTMLCanvasElement.prototype.getContext;
			HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
				return type === "webgl2" ? null : get.call(this, type, ...rest);
			};
		},
		expect: { error: /not supported in this browser \(missing: webgl2\)/ },
	},
	{
		name: "no WebAssembly",
		init: () => {
			delete globalThis.WebAssembly;
		},
		expect: { error: /missing: wasm/ },
	},
];

let failed = 0;
for (const c of cases) {
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
	await page.addInitScript(c.init);
	await page.goto(c.query ? `${url}?${c.query}` : url);
	let ok;
	let detail;
	if (c.expect.error) {
		await page.waitForTimeout(1500);
		const supported = await page.evaluate((m) => import(m).then((s) => s.isEngineSupported()), supportModule);
		ok = !supported && errors.some((e) => c.expect.error.test(e));
		detail = `isEngineSupported()=${supported}; ${errors[0] ?? "no error"}`;
	} else {
		await page.waitForFunction(() => window.__firstPaintMs !== undefined, null, { timeout: 15000 }).catch(() => {});
		// Scroll so frames run and stats are reported.
		await page.mouse.move(500, 350);
		for (let i = 0; i < 10; i++) {
			await page.mouse.wheel(0, 120);
			await page.waitForTimeout(60);
		}
		await page.waitForTimeout(900);
		const state = await page.evaluate(async () => {
			const v = window.__viewer;
			if (!v) return null;
			const hits = await v.search("programmable matter");
			const tiles = Math.max(0, ...window.__events.map((e) => e.stats.tiles));
			return { offscreen: v.offscreen, hits: hits.length, tiles };
		});
		ok = !!state && state.offscreen === c.expect.offscreen && state.hits > 0 && state.tiles > 0 && errors.length === 0;
		detail = `${JSON.stringify(state)}${errors.length ? ` errors: ${errors.join(" | ")}` : ""}`;
	}
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  — ${detail}`);
	await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
