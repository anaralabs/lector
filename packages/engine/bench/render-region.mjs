// Headless region renders (createPageRenderer) against the demo: cold (worker boot + open) and warm, with the PDF bytes each fetched.
//   pnpm dev   # demo on :5199
//   node bench/render-region.mjs http://127.0.0.1:5199/ <file>[@page]... [-- <out dir for PNGs>]
// Files are absolute paths (served through Vite's /@fs/) or URLs. Exits non-zero when a render fails.
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [base = "http://127.0.0.1:5199/", ...rest] = process.argv.slice(2);
const split = rest.indexOf("--");
const files = (split < 0 ? rest : rest.slice(0, split)).map((f) => {
	const [path, page = "0"] = f.split("@");
	return { url: /^https?:/.test(path) ? path : `${new URL(base).origin}/@fs${path}`, page: Number(page) };
});
const out = split < 0 ? null : rest[split + 1];
const channel = process.env.CHANNEL ?? "";
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : channel ? { channel } : {}), headless: true, args: ["--ignore-certificate-errors"] });
const page = await browser.newPage({ deviceScaleFactor: 2 });
let bytes = 0;
page.on("response", async (res) => {
	if (!res.url().includes(".pdf")) return;
	const body = await res.body().catch(() => null);
	bytes += body?.length ?? 0;
});
await page.goto(base);
await page.waitForFunction(() => window.__pageRenderer !== undefined);
let failed = false;
for (const [i, { url, page: p }] of files.entries()) {
	for (const run of ["cold", "warm"]) {
		bytes = 0;
		const res = await page.evaluate(
			async ({ url, p, run }) => {
				const t0 = performance.now();
				try {
					const r = await window.__pageRenderer.render(url, { page: p, width: 720, key: url, region: (s) => ({ x: s.w * 0.1, y: s.h * (run === "cold" ? 0.15 : 0.45), w: s.w * 0.8, h: s.h * 0.12 }) });
					const c = document.createElement("canvas");
					c.width = r.bitmap.width;
					c.height = r.bitmap.height;
					c.getContext("2d").drawImage(r.bitmap, 0, 0);
					const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
					let ink = 0;
					for (let k = 0; k < px.length; k += 4) if (px[k] < 128) ink++;
					return { ms: performance.now() - t0, w: c.width, h: c.height, pages: r.pageCount, ink, png: c.toDataURL("image/png") };
				} catch (err) {
					return { error: String(err?.message ?? err) };
				}
			},
			{ url, p, run },
		);
		await page.waitForTimeout(150);
		if (res.error) {
			failed = true;
			console.log(`FAIL  ${url} p${p + 1} ${run}: ${res.error}`);
			continue;
		}
		console.log(`${run.padEnd(4)}  ${res.ms.toFixed(0).padStart(5)}ms  ${(bytes / 1024).toFixed(0).padStart(6)}KB  ${res.w}x${res.h} ink=${res.ink}  ${url.split("/").pop()} p${p + 1}/${res.pages}`);
		if (out) writeFileSync(`${out}/region-${i}-${run}.png`, Buffer.from(res.png.split(",")[1], "base64"));
	}
}
await browser.close();
process.exit(failed ? 1 : 0);
