// First paint when a host creates the viewer hostDelay ms after the URL is known, with and without a prefetch started at that moment.
//   node bench/serve.mjs <root> 5300   (root holds the demo built with --base /<build>/ and the PDFs)
//   node bench/host-prefetch.mjs https://127.0.0.1:5300 <build> <runs> <hostDelay> -- <file>... -- <mbit/rtt>...
import { chromium } from "playwright-core";

const [base, build, runsArg = "5", delayArg = "300", ...rest] = process.argv.slice(2);
const runs = Number(runsArg);
const [files, nets] = rest.join(" ").split("--").map((s) => s.split(" ").filter(Boolean)).filter((a) => a.length);
const variants = [
	["url", ""],
	["wait", "&prefetch=wait"],
	["promise", "&prefetch=promise"],
];
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const api = (path) => fetch(`${base}${path}`).then((r) => r.text());
const browser = await chromium.launch({
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
	headless: true,
	args: ["--enable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-certificate-errors"],
});
const med = (a) => {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};
const idle = async () => {
	for (let i = 0; i < 300 && Number(await api("/__active")) > 0; i++) await new Promise((r) => setTimeout(r, 100));
};
const open = async (page, url) => {
	await page.goto(url);
	await page.waitForFunction(() => window.__marks?.painted !== undefined || window.__errors?.length, null, { timeout: 120000 });
	return page.evaluate(() => ({ painted: window.__marks.painted - window.__marks.host, errors: window.__errors.map((e) => e.message), load: window.__all.find((e) => e.type === "load")?.timings }));
};

let nonce = 0;
for (const net of nets) {
	const [mbit, rtt] = net.split("/").map(Number);
	for (const file of files) {
		const results = {};
		for (let i = 0; i < runs; i++) {
			for (const [name, query] of variants) {
				const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
				const page = await ctx.newPage();
				await api("/__config?mbit=0&rtt=0");
				await open(page, `${base}/${build}/index.html?preload=1&file=/pdf/form.pdf`);
				await page.goto("about:blank");
				await idle();
				await api(`/__config?mbit=${mbit}&rtt=${rtt}`);
				const at = await open(page, `${base}/${build}/index.html?preload=1&hostDelay=${delayArg}${query}&file=${encodeURIComponent(`${file}?n=${process.pid}-${nonce++}`)}`);
				if (at.errors.length) console.error(name, at.errors[0]);
				(results[name] ??= []).push(at.painted);
				if (process.env.VERBOSE) console.log(name, Math.round(at.painted), JSON.stringify(at.load));
				await page.goto("about:blank");
				await idle();
				await ctx.close();
			}
		}
		const line = variants.map(([name]) => `${name} ${med(results[name]).toFixed(0).padStart(5)}ms`).join("  ");
		console.log(`${String(mbit).padStart(3)}Mbit ${String(rtt).padStart(3)}ms  ${file.padEnd(16)} hostDelay ${delayArg}ms  ${line}`);
		console.log(`JSON ${JSON.stringify({ mbit, rtt, file, delay: Number(delayArg), results })}`);
	}
}
await api("/__config?mbit=0&rtt=0");
await browser.close();
