// Opens non-linearized PDFs (xref and trailer at the end) over range loading
// against servers that misbehave the ways CDNs do, and fails on any open error.
//   node bench/serve.mjs <root> 5300   (root holds the demo build under /main/; this script writes /pdf/robust-*.pdf there)
//   node bench/open-robust.mjs https://127.0.0.1:5300 <root> [build=main]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { makeUnlinearized } from "../test/fixtures/make-unlinearized.mjs";

const [base = "https://127.0.0.1:5300", root, build = "main"] = process.argv.slice(2);
const MB = 1024 * 1024;
const files = {
	"robust-7m.pdf": { pages: 30, bytes: 7 * MB },
	"robust-8m.pdf": { pages: 30, bytes: 8 * MB + 64 * 1024 },
	"robust-12m-xrefstm-updates.pdf": { pages: 40, bytes: 12 * MB, xrefStream: true, updates: 3 },
	"robust-20m.pdf": { pages: 60, bytes: 20 * MB, updates: 1 },
	"robust-preamble.pdf": { pages: 10, bytes: 2 * MB, preamble: 4096 },
	"robust-preamble-12m.pdf": { pages: 30, bytes: 12 * MB, xrefStream: true, preamble: 70000 },
};
mkdirSync(join(root, "pdf"), { recursive: true });
for (const [name, o] of Object.entries(files)) {
	writeFileSync(join(root, "pdf", name), makeUnlinearized(o));
	// the same document rewritten (another layout and length), for SWAP
	writeFileSync(join(root, "pdf", `${name}.v2`), makeUnlinearized({ ...o, bytes: o.bytes + 3 * MB, pages: o.pages + 2 }));
}
const modes = (process.env.MODES ?? "plain expose=0 short=1048576 short=1048576&expose=0 swap=1").split(" ");
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-certificate-errors"] });
let failed = 0;
for (const mode of modes) {
	for (const name of Object.keys(files)) {
		await fetch(`${base}/__config?${new URLSearchParams({ expose: "1", short: "0", swap: "0", ...Object.fromEntries(new URLSearchParams(mode === "plain" ? "" : mode)) })}`);
		await fetch(`${base}/__reset`);
		const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, ignoreHTTPSErrors: true });
		const page = await ctx.newPage();
		await page.goto(`${base}/${build}/index.html?preload=1&range=1&file=/pdf/${name}`);
		const out = await page
			.waitForFunction(() => window.__marks?.ready !== undefined || window.__errors?.length, null, { timeout: 60000 })
			.then(() => page.evaluate(() => ({ errors: window.__errors.map((e) => `${e.code}/${e.phase}: ${e.message}`), pages: window.__all.find((e) => e.type === "ready")?.pages?.length, load: window.__all.find((e) => e.type === "load")?.timings?.loadMode })))
			.catch((err) => ({ errors: [String(err).slice(0, 200)] }));
		const ok = out.errors.length === 0;
		if (!ok) failed++;
		console.log(`${ok ? "ok  " : "FAIL"} ${mode.padEnd(28)} ${name.padEnd(34)} pages ${out.pages ?? "-"} ${out.load ?? ""} ${out.errors.join(" | ")}`);
		await ctx.close();
	}
}
await browser.close();
process.exit(failed ? 1 : 0);
