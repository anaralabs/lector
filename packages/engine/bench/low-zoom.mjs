// Low-zoom multi-page coverage: zoom in and out (pinch and buttons), settle at ~22%, then every visible page must show a bitmap and no raster job may hang.
// Usage: node bench/low-zoom.mjs [url]; ACCEL=1 accelerated Canvas 2D (SwiftShader), COMPOSITORS=canvas2d,webgl2
import { chromium } from "playwright-core";
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const files = (process.env.FILES ?? "text.pdf,heavy-scan.pdf").split(",");
const accel = ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--enable-gpu-rasterization", "--enable-accelerated-2d-canvas"];
const browser = await chromium.launch({ executablePath: exe, headless: true, args: process.env.ACCEL === "1" ? accel : [] });
let failed = 0;
for (const comp of (process.env.COMPOSITORS ?? "canvas2d,webgl2").split(",")) {
	for (const file of files) {
		for (const dark of ["0", "1"]) {
			const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
			const errors = [];
			page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text().slice(0, 200)));
			page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
			await page.goto(`${url}?file=/${file}&compositor=${comp}&dark=${dark}&offscreen=0`);
			await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 60000 });
			await page.waitForTimeout(800);
			await page.evaluate(async () => {
				const el = document.getElementById("viewer");
				const wheel = (dy) => el.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, ctrlKey: true, clientX: 640, clientY: 430, bubbles: true, cancelable: true }));
				const pinch = async (dy, n) => {
					for (let i = 0; i < n; i++) {
						wheel(dy);
						await new Promise((r) => setTimeout(r, 8));
					}
					await new Promise((r) => setTimeout(r, 400));
				};
				await pinch(-4, 80);
				await pinch(6, 120);
				await pinch(-5, 60);
				for (let i = 0; i < 3; i++) {
					window.__viewer.zoomTo(window.__viewer.camera.zoom * 1.25);
					await new Promise((r) => setTimeout(r, 250));
				}
				for (let i = 0; i < 12; i++) {
					window.__viewer.zoomTo(window.__viewer.camera.zoom / 1.25);
					await new Promise((r) => setTimeout(r, 150));
				}
				await pinch(8, 60);
				window.__viewer.zoomTo(0.22);
			});
			// every visible page drawn, or give up after 20s
			const r = await page.evaluate(async () => {
				const c = globalThis.__core;
				const t0 = performance.now();
				let probe = c.debugProbe();
				while (probe.drawn < 0.999 && performance.now() - t0 < 20000) {
					await new Promise((r) => setTimeout(r, 250));
					probe = c.debugProbe();
				}
				return { zoom: c.cam.zoom, drawn: +probe.drawn.toFixed(3), ms: Math.round(performance.now() - t0), pending: probe.pending, compositor: document.getElementById("viewer").dataset.compositor };
			});
			const ok = r.drawn >= 0.999 && errors.length === 0 && r.compositor === comp;
			if (!ok) failed++;
			console.log(JSON.stringify({ comp, file, dark: dark === "1", ...r, errors: [...new Set(errors)].slice(0, 3), ok }));
			await page.close();
		}
	}
}
await browser.close();
process.exitCode = failed ? 1 : 0;
