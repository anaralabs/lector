// Software-rendering bench: current WebGL2 compositor on SwiftShader vs the Canvas 2D compositor
// (on the same machine, and with WebGL disabled outright). Prints one JSON line per run.
// Usage: node bench/softgl.mjs [dpr] [files,comma] [modes,comma]
import { chromium } from "playwright-core";

const base = process.env.URL ?? "http://127.0.0.1:5199/";
const dpr = Number(process.argv[2] ?? 1);
const files = (process.argv[3] ?? "text.pdf,heavy-vector.pdf,heavy-scan.pdf").split(",");
const modes = (process.argv[4] ?? "gl-swiftshader,2d-swiftshader,2d-nogpu").split(",");
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const MODE = {
	"gl-swiftshader": { args: [], compositor: "webgl2" },
	"2d-swiftshader": { args: [], compositor: "canvas2d" },
	"2d-nogpu": { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2"], compositor: "auto" },
};
const extra = process.env.DARK === "1" ? "&dark=1" : "";

for (const mode of modes) {
	const m = MODE[mode];
	const browser = await chromium.launch({ executablePath: exe, headless: true, args: m.args });
	for (const file of files) {
		const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: dpr });
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e)));
		page.on("console", (msg) => msg.type() === "error" && !msg.text().includes("404") && errors.push(msg.text()));
		const t0 = Date.now();
		await page.goto(`${base}?file=/${file}&compositor=${m.compositor}${extra}`);
		await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 60000 });
		const painted = await page.evaluate(() => window.__paintedMs);
		const ready = await page.evaluate(() => window.__firstPaintMs);
		await page.waitForTimeout(1500);
		const drive = (frames, step) =>
			page.evaluate(
				async ({ frames, step }) => {
					const el = document.getElementById("viewer");
					const fn = new Function("i", "el", "wheel", step);
					const wheel = (dx, dy, ctrl, x = 640, y = 430) =>
						el.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, ctrlKey: ctrl, clientX: x, clientY: y, bubbles: true, cancelable: true }));
					window.__events.length = 0;
					const t0 = performance.now();
					for (let i = 0; i < frames; i++) {
						fn(i, el, wheel);
						await new Promise((r) => requestAnimationFrame(r));
					}
					const ms = performance.now() - t0;
					const during = window.__events.length;
					await new Promise((r) => setTimeout(r, 700));
					return { ms, during, stats: window.__events.map((e) => e.stats) };
				},
				{ frames, step },
			).then(({ ms, during, stats: ev }) => {
				const busy = ev.slice(0, during + 1).filter((s) => s.frames > 0);
				const drawn = ev.slice(0, during + 1).reduce((a, s) => a + s.frames, 0);
				const sum = (k) => busy.reduce((a, s) => a + s[k], 0);
				const frames = sum("frames");
				const wavg = (k) => (frames ? busy.reduce((a, s) => a + s[k] * s.frames, 0) / frames : 0);
				return {
					eff: +((drawn * 1000) / ms).toFixed(1),
					fps: +wavg("fps").toFixed(1),
					p95: +Math.max(0, ...busy.map((s) => s.p95FrameMs)).toFixed(1),
					worst: +Math.max(0, ...busy.map((s) => s.worstFrameMs)).toFixed(0),
					over33: sum("framesOver33"),
					frames,
					cpu: +wavg("avgCpuMs").toFixed(2),
					mb: +Math.max(0, ...busy.map((s) => s.textureMB)).toFixed(0),
					comp: busy[0]?.compositor,
				};
			});
		const scroll = await drive(300, "wheel(0, 30, false)");
		const zoom = await drive(150, "wheel(0, -6, true, 400, 300)");
		await page.waitForTimeout(800);
		const pan = await drive(240, "wheel(Math.sin(i/20)*20, 25, false)");
		const zoomOut = await drive(150, "wheel(0, 8, true)");
		await page.screenshot({ path: `/tmp/softgl-${mode}-${file}-${dpr}${extra ? "-dark" : ""}.png` });
		console.log(JSON.stringify({ mode, file, dpr, dark: !!extra, painted: Math.round(painted), ready: Math.round(ready), scroll, zoom, pan, zoomOut, errors: errors.slice(0, 2), wall: Date.now() - t0 }));
		await page.close();
	}
	await browser.close();
}
