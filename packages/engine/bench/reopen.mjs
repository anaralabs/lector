// Open a document at a page, let it settle and go idle, then open it again in the
// same profile: time to drawn / sharp both times. Fresh profile per run.
// Usage: BASE=http://127.0.0.1:5199 node bench/reopen.mjs [file] [page] [extra query] [runs]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [file = "/heavy-scan.pdf", pageNo = "40", extra = "", runs = "3"] = process.argv.slice(2);
const touch = process.env.TOUCH === "1";
const url = `${process.env.BASE ?? "http://127.0.0.1:5199"}/?file=${file}&page=${pageNo}${extra}`;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = [];
for (let r = 0; r < Number(runs); r++) {
	const dir = mkdtempSync(join(tmpdir(), "lector-reopen-"));
	const ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: true, viewport: touch ? { width: 820, height: 1180 } : { width: 1280, height: 860 }, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch, args: ["--enable-gpu", "--use-angle=metal"] });
	const page = ctx.pages()[0];
	const measure = async () => {
		const t0 = Date.now();
		await page.goto(url);
		await page.waitForFunction(() => window.__firstPaintMs !== undefined, null, { timeout: 60000 });
		let core = null;
		while (!core) {
			if (await page.evaluate(() => !!globalThis.__core)) core = "main";
			else core = await Promise.any(page.workers().map(async (w) => ((await w.evaluate(() => !!self.__core)) ? w : Promise.reject()))).catch(() => null);
		}
		const probe = () => (core === "main" ? page.evaluate(() => globalThis.__core.debugProbe()) : core.evaluate(() => self.__core.debugProbe()));
		let drawn = null;
		for (;;) {
			const p = await probe();
			const t = Date.now() - t0;
			if (drawn === null && p.drawn >= 0.999) drawn = t;
			if (p.drawn >= 0.999 && p.sharp >= 0.999) return { drawn, sharp: t };
			if (t > 30000) return { drawn: drawn ?? t, sharp: t };
			await page.waitForTimeout(5);
		}
	};
	const first = await measure();
	await page.waitForTimeout(4000);
	const again = await measure();
	rows.push({ first, again });
	await ctx.close();
	rmSync(dir, { recursive: true, force: true });
}
const f = (k, m) => med(rows.map((r) => r[k][m])).toFixed(0);
console.log(`${file} p${pageNo}${extra}${touch ? " [touch]" : ""}: open drawn ${f("first", "drawn")} sharp ${f("first", "sharp")}  reopen drawn ${f("again", "drawn")} sharp ${f("again", "sharp")}  (median of ${runs}) ${JSON.stringify(rows.map((r) => [r.first.drawn, r.again.drawn]))}`);
