// Forces a permanent WebGL context loss and checks the viewer continues on the 2D compositor.
import { chromium } from "playwright-core";
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe, headless: true });
for (const offscreen of ["0", "1"]) {
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
	await page.goto(`http://127.0.0.1:5199/?file=/text.pdf&compositor=webgl2&offscreen=${offscreen}`);
	await page.waitForFunction(() => window.__paintedMs !== undefined);
	await page.waitForTimeout(800);
	const before = await page.evaluate(() => window.__viewer.compositor);
	const lose = "(self.__core ?? globalThis.__core).gl.gl.getExtension('WEBGL_lose_context').loseContext()";
	if (offscreen === "0") await page.evaluate(lose);
	else {
		const w = page.workers().find((x) => x.url().startsWith("blob:") && x.url()) ;
		let done = false;
		for (const wk of page.workers()) {
			if (done) break;
			done = await wk.evaluate(`(() => { if (!self.__core) return false; ${lose}; return true; })()`).catch(() => false);
		}
		if (!done) console.log("no compositor worker found");
	}
	const t0 = Date.now();
	await page.waitForFunction(() => window.__viewer.compositor === "canvas2d", null, { timeout: 8000 }).catch(() => {});
	const swapMs = Date.now() - t0;
	await page.waitForTimeout(1000);
	const after = await page.evaluate(() => ({ comp: window.__viewer.compositor, events: window.__all.filter((e) => ["need-canvas", "compositor", "error", "restored"].includes(e.type)).map((e) => e.type + (e.code ? ":" + e.code : "")) }));
	await page.evaluate(async () => {
		const el = document.getElementById("viewer");
		for (let i = 0; i < 60; i++) {
			el.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, clientX: 640, clientY: 430, bubbles: true, cancelable: true }));
			await new Promise((r) => requestAnimationFrame(r));
		}
	});
	await page.waitForTimeout(1200);
	await page.screenshot({ path: `/tmp/softgl-loss-offscreen${offscreen}.png` });
	console.log(JSON.stringify({ offscreen, before, swapMs, ...after }));
	await page.close();
}
await browser.close();
