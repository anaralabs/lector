import { chromium } from "playwright-core";
const url = process.argv[2];
const runs = Number(process.argv[3] ?? 8);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--use-angle=metal"] });
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const measure = async (page) => {
	await page.goto(url);
	await page.waitForFunction(() => window.__all?.some((e) => e.type === "painted") && window.__firstPaintMs !== undefined, null, { timeout: 30000 });
	return page.evaluate(() => ({ ready: window.__firstPaintMs, painted: performance.now() }));
};
const cold = [], warm = [];
for (let i = 0; i < runs; i++) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
	const page = await ctx.newPage();
	if (process.env.CPU) {
		const cdp = await ctx.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU) });
	}
	cold.push(await measure(page));
	warm.push(await measure(page));
	await ctx.close();
}
const fmt = (a, k) => `${med(a.map((x) => x[k])).toFixed(0)}ms`;
console.log(`cold: ready ${fmt(cold, "ready")}  painted(since nav) ${fmt(cold, "painted")}   warm: ready ${fmt(warm, "ready")}  painted ${fmt(warm, "painted")}   (median of ${runs})`);
await browser.close();
