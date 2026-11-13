// Raster worker failures stay inside the engine: a page whose PDFium crashes for good shows a placeholder while the rest
// renders, and workers that cannot reserve memory at boot leave fewer workers. No `error` event either way.
//   node bench/fixtures/make-links.mjs && pnpm dev &  URL=http://127.0.0.1:5199/ node bench/worker-faults.mjs
import { chromium } from "playwright-core";
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const base = process.env.URL ?? "http://127.0.0.1:5199/";
const file = process.env.FILE ?? "/links.pdf";
const cases = [
	{ name: "page 1 crashes for good, every worker", q: "fault=1&workers=2", failed: [1] },
	{ name: "page 1 crashes for good, one worker", q: "fault=1&workers=1", failed: [1] },
	{ name: "first page crashes for good", q: "fault=0&workers=2", failed: [0] },
	{ name: "both workers out of memory at boot", q: "bootOom=2&workers=2", failed: [] },
	{ name: "one of three workers out of memory at boot", q: "bootOom=1&workers=3", failed: [] },
];
let failures = 0;
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const c of cases) {
	for (const offscreen of ["0", "1"]) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 1 });
		try {
			await page.goto(`${base}?file=${file}&offscreen=${offscreen}&${c.q}`);
			await page.waitForFunction(() => window.__all?.some((e) => e.type === "painted"), null, { timeout: 30000 });
			await page.waitForTimeout(1500);
			const r = await page.evaluate(() => ({
				errors: window.__all.filter((e) => e.type === "error").map((e) => `${e.code}/${e.phase}: ${e.message}`),
				failed: window.__all.filter((e) => e.type === "page-failed").map((e) => e.page),
				placeholders: [...document.querySelectorAll(".lector-page-failed")].map((el) => Number(el.dataset.page)),
				workers: window.__events.at(-1)?.stats?.workers,
			}));
			// the viewer still answers requests: page 0's text when it rendered, else page 2's
			const textPage = c.failed.includes(0) ? 2 : 0;
			const text = await page.evaluate((p) => window.__viewer.pageText(p).then((t) => t.length), textPage).catch((e) => `rejected: ${e}`);
			const ok = r.errors.length === 0 && JSON.stringify([...new Set(r.failed)]) === JSON.stringify(c.failed) && JSON.stringify(r.placeholders) === JSON.stringify(c.failed) && typeof text === "number";
			if (!ok) failures++;
			console.log(JSON.stringify({ case: c.name, offscreen, ok, ...r, text }));
		} catch (err) {
			failures++;
			console.log(JSON.stringify({ case: c.name, offscreen, ok: false, error: String(err).split("\n")[0] }));
		}
		await page.close();
	}
}
await browser.close();
process.exit(failures ? 1 : 0);
