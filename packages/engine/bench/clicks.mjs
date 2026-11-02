// Double/triple-click selection in Chrome, Firefox and WebKit (pointer events
// report detail 0, so the shell counts presses itself).
// Usage: node bench/clicks.mjs [url]   (npx playwright-core install firefox webkit)
import { chromium, firefox, webkit } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
let failed = 0;
for (const [name, type, opts] of [
	["chrome", chromium, { channel: "chrome" }],
	["firefox", firefox, {}],
	["webkit", webkit, {}],
]) {
	let browser;
	try {
		browser = await type.launch({ headless: true, ...opts });
	} catch {
		console.log(`SKIP  ${name}  — not installed`);
		continue;
	}
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
	await page.goto(url);
	await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 30000 });
	const at = await page.evaluate(async () => {
		const v = window.__viewer;
		const m = await v.pageTextMap(0);
		const i = m.text.indexOf("toolbox");
		const [r] = await v.rects(0, m.chars[i], m.chars[i + 7]);
		const layout = window.__all.find((e) => e.type === "ready").layout[0];
		const cam = v.camera;
		return { x: (layout.x + r.x + r.w / 2 - cam.x) * cam.zoom, y: (layout.y + r.y + r.h / 2 - cam.y) * cam.zoom };
	});
	await page.mouse.dblclick(at.x, at.y);
	await page.waitForTimeout(250);
	const word = await page.evaluate(() => window.__viewer.selectedText);
	await page.mouse.click(at.x, at.y, { clickCount: 3 });
	await page.waitForTimeout(250);
	const line = await page.evaluate(() => window.__viewer.selectedText);
	await page.waitForTimeout(600);
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(250);
	const single = await page.evaluate(() => window.__viewer.selectedText);
	const ok = word === "toolbox" && line.includes("toolbox") && line.length > 20 && !line.trim().includes("\n") && single === "";
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  — ${JSON.stringify(word)} / ${JSON.stringify(line)} / single click ${JSON.stringify(single)}`);
	await browser.close();
}
process.exit(failed ? 1 : 0);
