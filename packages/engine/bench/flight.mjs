// Animated reveal (citation jump) benchmark on the CADbots demo: frame times
// while the camera flies, how sharp the destination is when it lands, and
// screenshots mid-flight and at landing.
// Usage: node bench/flight.mjs [url] [outDir]
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
await page.waitForTimeout(1200);

// Citation-like targets: a ~300-char passage starting at a search hit, on several pages.
const targets = await page.evaluate(async () => {
	const v = window.__viewer;
	const hits = await v.search("robot", 2000);
	const byPage = new Map();
	for (const h of hits) if (!byPage.has(h.page)) byPage.set(h.page, h);
	const box = (rs) => {
		const x0 = Math.min(...rs.map((r) => r.x));
		const y0 = Math.min(...rs.map((r) => r.y));
		const x1 = Math.max(...rs.map((r) => r.x + r.w));
		const y1 = Math.max(...rs.map((r) => r.y + r.h));
		return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	};
	const out = [];
	for (const p of [0, 1, 3, 12, 19, 24]) {
		const h = byPage.get(p) ?? [...byPage.values()].sort((a, b) => Math.abs(a.page - p) - Math.abs(b.page - p))[0];
		const rects = await v.rects(h.page, h.index, h.index + 300);
		out.push({ page: h.page, rect: box(rects), rects });
	}
	return out;
});
console.log("targets on pages", targets.map((t) => t.page + 1).join(", "));

const fly = (label, t, opts = {}) =>
	page.evaluate(
		async ({ t, opts, label }) => {
			const v = window.__viewer;
			v.setHighlights([{ id: `c:${label}`, page: t.page, rects: t.rects, color: [0.35, 0.6, 1, 0.45], interactive: false }]);
			const statsBefore = window.__events.length;
			const t0 = performance.now();
			const landed = await v.reveal(t.page, t.rect, { animate: true, ...opts });
			const t1 = performance.now();
			const f = window.__flights.at(-1);
			v.pulse(`c:${label}`);
			await new Promise((r) => setTimeout(r, 1100));
			const stats = window.__events.slice(statsBefore).map((e) => e.stats);
			// sharpness a little after landing too (an ifNeeded reveal does not move)
			await v.reveal(t.page, t.rect, { ifNeeded: true });
			const after = window.__flights.at(-1);
			return { landed, ms: t1 - t0, flight: f, after, stats };
		},
		{ t, opts, label },
	);

const results = [];
const run = async (label, t, opts) => {
	const r = await fly(label, t, opts);
	results.push({ label, ...r });
	const f = r.flight;
	const p95 = r.stats.length ? Math.max(...r.stats.map((s) => s.p95FrameMs)) : NaN;
	const worst = r.stats.length ? Math.max(...r.stats.map((s) => s.worstFrameMs)) : NaN;
	console.log(
		`${label.padEnd(30)} landed=${r.landed} total ${r.ms.toFixed(0)}ms (wait ${f?.waitMs.toFixed(0)}ms + flight ${f?.durationMs.toFixed(0)}ms)  coverage@land ${(f?.coverage * 100).toFixed(0)}%  @+1.1s ${(r.after?.coverage * 100).toFixed(0)}%  p95 ${p95.toFixed(1)}ms worst ${worst.toFixed(1)}ms`,
	);
};

await page.evaluate(() => {
	window.__viewer.fitWidth();
});
await page.waitForTimeout(400);
await run("short: p1 -> p2", targets[1]);
await run("short: p2 -> p1", targets[0]);
await run("medium: p1 -> p4", targets[2]);
await run("long: p4 -> p13 (cold)", targets[3]);
await run("long: p13 -> p20 (cold)", targets[4]);
await run("long: p20 -> p1 (warm)", targets[0]);
await page.evaluate(() => window.__viewer.zoomTo(2.4));
await page.waitForTimeout(600);
await run("zoomed: p1 -> p25 (cold)", targets[5]);
// Tall rect: forces a zoom-out during the flight.
const tall = { ...targets[2], rect: { x: 40, y: 60, w: 500, h: 700 } };
await run("zoom-out: p25 -> tall p4", tall);
await page.evaluate(() => window.__viewer.fitWidth());
await page.waitForTimeout(400);

// Screenshots mid-flight and at landing (long jump).
await page.evaluate(() => window.__viewer.goToPage(0));
await page.waitForTimeout(600);
const t = targets[4];
await page.evaluate((t) => {
	window.__viewer.setHighlights([{ id: "shot", page: t.page, rects: t.rects, color: [0.35, 0.6, 1, 0.45], interactive: false }]);
	window.__shotFlight = window.__viewer.reveal(t.page, t.rect, { animate: true });
}, t);
await page.waitForTimeout(20);
await page.screenshot({ path: `${out}/flight-mid.png` });
await page.evaluate(() => window.__shotFlight);
await page.screenshot({ path: `${out}/flight-landed.png` });
await page.evaluate(() => window.__viewer.pulse("shot"));
await page.waitForTimeout(180);
await page.screenshot({ path: `${out}/flight-pulse.png` });
await page.waitForTimeout(1200);
await page.evaluate(() => window.__viewer.setOptions({ dark: true, background: [0.03, 0.03, 0.03], paper: [0.05, 0.05, 0.05] }));
await page.evaluate(() => window.__viewer.pulse("shot"));
await page.waitForTimeout(180);
await page.screenshot({ path: `${out}/flight-pulse-dark.png` });
await page.evaluate(() => window.__viewer.setOptions({ dark: false, background: [0.93, 0.93, 0.94] }));

// Interrupt: a wheel event mid-flight stops the camera where it is.
await page.evaluate(() => window.__viewer.goToPage(0));
await page.waitForTimeout(400);
const interrupted = await page.evaluate(async (t) => {
	const p = window.__viewer.reveal(t.page, t.rect, { animate: true });
	await new Promise((r) => setTimeout(r, 120));
	document.getElementById("viewer").dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true, cancelable: true }));
	return p;
}, targets[3]);
console.log(`wheel mid-flight cancels: ${interrupted === false ? "PASS" : "FAIL"}`);

console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no errors");
await browser.close();
