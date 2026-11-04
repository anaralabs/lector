// Double/triple/quadruple click (word, sentence, paragraph) in Chrome, Firefox and WebKit; the shell counts presses itself.
// Usage: node bench/fixtures/make-paper.mjs && node bench/clicks.mjs [url]   (npx playwright-core install firefox webkit)
import { chromium, firefox, webkit } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
let failed = 0;
for (const [name, type, opts] of [
	["chrome", chromium, { channel: "chrome" }],
	["chromium", chromium, {}],
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
	const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
	await page.goto(`${url}?file=/paper.pdf&zoom=fit-page`);
	try {
		await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 30000 });
	} catch {
		failed++;
		console.log(`FAIL  ${name}  — never painted (no WebGL2?)`);
		await browser.close();
		continue;
	}
	const at = await page.evaluate(async () => {
		const v = window.__viewer;
		const m = await v.pageTextMap(0);
		const i = m.text.indexOf("threshold");
		const [r] = await v.rects(0, m.chars[i], m.chars[i + 9]);
		const layout = window.__all.find((e) => e.type === "ready").layout[0];
		const cam = v.camera;
		return { x: (layout.x + r.x + r.w / 2 - cam.x) * cam.zoom, y: (layout.y + r.y + r.h / 2 - cam.y) * cam.zoom };
	});
	const select = async (clickCount) => {
		await page.mouse.click(at.x, at.y, { clickCount });
		await page.waitForTimeout(250);
		const text = await page.evaluate(() => window.__viewer.selectedText.replace(/\s+/g, " ").trim());
		await page.waitForTimeout(600);
		return text;
	};
	const word = await select(2);
	const sentence = await select(3);
	const paragraph = await select(4);
	const single = await select(1);
	const ok =
		word === "threshold" &&
		sentence === "Eq. (3) gives the gap threshold in units of the median glyph height." &&
		paragraph.startsWith("Every page is first split") &&
		paragraph.endsWith("by a clear gap.") &&
		single === "";
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  — ${JSON.stringify(word)} / ${JSON.stringify(sentence)} / ${JSON.stringify(paragraph.slice(0, 40))}… / single click ${JSON.stringify(single)}`);
	await browser.close();
}
process.exit(failed ? 1 : 0);
