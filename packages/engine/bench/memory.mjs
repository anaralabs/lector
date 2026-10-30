// Large-file loading: time to `ready` (page sizes known) and `painted` (first
// bitmap on screen), and the browser's resident memory once settled.
// Usage: node bench/memory.mjs [file=/big.pdf] [extra query, e.g. "&range=1"] [throttle Mbit/s]
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const file = process.argv[2] ?? "/big.pdf";
const extra = process.argv[3] ?? "";
const mbit = Number(process.argv[4] ?? 0);
const dir = mkdtempSync(join(tmpdir(), "lector-mem-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: true, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, args: ["--enable-gpu", "--use-angle=metal"] });
const page = ctx.pages()[0] ?? (await ctx.newPage());
if (mbit) {
	const cdp = await ctx.newCDPSession(page);
	await cdp.send("Network.enable");
	await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: (mbit * 1e6) / 8, uploadThroughput: (mbit * 1e6) / 8 });
}
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("crash", () => console.log("renderer crashed"));
page.on("worker", (w) => w.on("console", (m) => console.log("worker:", m.text().slice(0, 200))));
await page.goto(`http://127.0.0.1:5199/?file=${file}${extra}`);
await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 300000 });
const t = await page.evaluate(() => ({ ready: window.__firstPaintMs, painted: window.__paintedMs }));
// Scroll a bit so several workers have rendered, then let things settle.
await page.evaluate(() => window.__viewer.goToPage(500));
await page.waitForTimeout(3000);
// The browser started with our profile dir, and every process below it.
const tree = () => {
	const rows = execSync("ps -axo pid=,ppid=,rss=,command=")
		.toString()
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [pid, ppid, rss, ...cmd] = l.trim().split(/\s+/);
			return { pid: +pid, ppid: +ppid, rss: +rss, cmd: cmd.join(" ") };
		});
	const root = rows.find((r) => r.cmd.includes(`--user-data-dir=${dir}`) && !r.cmd.includes("--type="));
	const ids = new Set([root?.pid]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const r of rows) if (ids.has(r.ppid) && !ids.has(r.pid)) (ids.add(r.pid), (grew = true));
	}
	const mine = rows.filter((r) => ids.has(r.pid));
	return { total: mine.reduce((s, r) => s + r.rss, 0), renderer: Math.max(0, ...mine.filter((r) => r.cmd.includes("--type=renderer")).map((r) => r.rss)) };
};
const mem = tree();
// Stats are emitted from frames: nudge one, then read the PDFium heap total.
const workerMB = await page.evaluate(async () => {
	const n = window.__events.length;
	window.__viewer.zoomTo(1.01);
	for (let i = 0; i < 60 && window.__events.length === n; i++) {
		document.getElementById("viewer").dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 50));
	}
	return window.__events.at(-1)?.stats.workerMB ?? 0;
});
console.log(`${file}${extra}${mbit ? ` @${mbit}Mbit/s` : ""}: ready ${t.ready.toFixed(0)}ms  painted ${t.painted.toFixed(0)}ms  browser RSS ${(mem.total / 1024).toFixed(0)}MB  renderer ${(mem.renderer / 1024).toFixed(0)}MB  PDFium workers ${workerMB.toFixed(0)}MB${errors.length ? `  ERRORS ${errors.join(" | ")}` : ""}`);
await ctx.close();
rmSync(dir, { recursive: true, force: true });
