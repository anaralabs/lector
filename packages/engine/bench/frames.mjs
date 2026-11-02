// Drives the demo in Chrome with input dispatched every animation frame
// (like a trackpad), then prints the engine's own frame statistics.
// Usage: node bench/frames.mjs [url] [outDir]
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const out = process.argv[3] ?? ".";
const browser = await chromium.launch({
	channel: "chrome",
	headless: process.env.HEADED !== "1",
	args: process.env.HEADED === "1" ? [] : ["--enable-gpu", "--use-angle=metal", "--disable-frame-rate-limit"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__firstPaintMs !== undefined, null, { timeout: 30000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/01-initial.png` });

// Runs `frames` animation frames, calling step(i) each frame inside the page.
const drive = (label, frames, step) =>
	page.evaluate(
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
			await new Promise((r) => setTimeout(r, 700));
			return window.__events.map((e) => e.stats);
		},
		{ frames, step },
	).then((ev) => {
		const busy = ev.filter((s) => s.fps > 0);
		const max = (k) => (busy.length ? Math.max(...busy.map((s) => s[k])).toFixed(1) : "-");
		const min = (k) => (busy.length ? Math.min(...busy.map((s) => s[k])).toFixed(0) : "-");
		console.log(`${label.padEnd(24)} fps(min) ${min("fps")}  p95 ${max("p95FrameMs")}ms  worst ${max("worstFrameMs")}ms  cpu/frame ${max("avgCpuMs")}ms  tile ${max("avgTileMs")}ms  gpu ${max("textureMB")}MB`);
	});

const jank = process.env.JANK === "1";
if (jank) {
	await page.evaluate(() => {
		setInterval(() => {
			const end = performance.now() + 50;
			while (performance.now() < end) {}
		}, 100);
	});
	console.log("(main thread blocked 50ms every 100ms)");
}

await drive("scroll", 300, "wheel(0, 30, false)");
await page.screenshot({ path: `${out}/02-scrolled.png` });
await drive("pinch in", 150, "wheel(0, -6, true, 400, 300)");
await page.screenshot({ path: `${out}/03-zoomed-moving.png` });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/04-zoomed-settled.png` });
await drive("pan+scroll zoomed", 300, "wheel(Math.sin(i/20)*20, 25, false)");
await drive("pinch + scroll together", 200, "wheel(0, i%2 ? 20 : 0, false); if (i%2==0) wheel(0, i<100 ? 5 : -5, true, 500, 400)");
await drive("pinch out", 200, "wheel(0, 8, true)");
await page.evaluate(() => window.__viewer.fitWidth());
await page.evaluate(() => window.__viewer.goToPage(0));
await page.waitForTimeout(1000);

// Selection: real mouse events via CDP across the abstract paragraph.
await page.mouse.move(330, 840 / 1.0);
const box = { x: 200, y: 560 };
await page.mouse.move(box.x, box.y);
await page.mouse.down();
for (let i = 1; i <= 40; i++) await page.mouse.move(box.x + i * 12, box.y + i * 3);
await page.mouse.up();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/05-selection.png` });
const sel = await page.evaluate(() => window.__viewer.selectedText);
console.log("selected text:", JSON.stringify(sel.slice(0, 200)), `(${sel.length} chars)`);
console.log("ready after:", await page.evaluate(() => window.__firstPaintMs.toFixed(0)), "ms");
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();
