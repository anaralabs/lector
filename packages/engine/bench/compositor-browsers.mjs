// The 2D compositor in Firefox and WebKit: probe result, worker placement, first paint and a scroll.
import { firefox, webkit } from "playwright-core";
const H = process.env.HOME;
const url = process.env.URL ?? "http://127.0.0.1:5199/";
for (const [name, type, exe] of [["firefox", firefox, `${H}/.cache/ms-playwright/firefox-1543/firefox/firefox`], ["webkit", webkit, `${H}/.cache/ms-playwright/webkit-2359/pw_run.sh`]]) {
	let browser;
	try {
		browser = await type.launch({ executablePath: exe, headless: true });
	} catch (e) {
		console.log(JSON.stringify({ name, launch: String(e).slice(0, 200) }));
		continue;
	}
	for (const comp of ["auto", "canvas2d"]) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
		await page.goto(`${url}?file=/text.pdf&compositor=${comp}`);
		const ok = await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 30000 }).then(() => true, () => false);
		const info = ok ? await page.evaluate(async () => {
			const el = document.getElementById("viewer");
			for (let i = 0; i < 40; i++) {
				el.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, clientX: 500, clientY: 400, bubbles: true, cancelable: true }));
				await new Promise((r) => requestAnimationFrame(r));
			}
			await new Promise((r) => setTimeout(r, 1500));
			const s = window.__events.at(-1)?.stats;
			return { compositor: window.__viewer.compositor, offscreen: window.__viewer.offscreen, paintedMs: Math.round(window.__paintedMs), statsComp: s?.compositor };
		}) : null;
		await page.screenshot({ path: `/tmp/sg-${name}-${comp}.png` });
		console.log(JSON.stringify({ name, comp, ok, ...info, errors: errors.slice(0, 2) }));
		await page.close();
	}
	await browser.close();
}
