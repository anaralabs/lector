// First paint across builds, files and throttled networks, engine warm and PDF cold (the open a host that preloads pdfium does).
// Serve a root holding each demo build under its own base (vite build --base /<name>/) next to the PDFs:
//   node bench/serve.mjs <root> 5300
//   node bench/load-matrix.mjs https://127.0.0.1:5300 <runs=3> <variant=build:query>... -- <file>... -- <mbit/rtt>...
// e.g. node bench/load-matrix.mjs https://127.0.0.1:5300 3 main-full:main:range=0 main-range:main:range=1 new:new:range=1 -- /pdf/small.pdf /pdf/scan-big.pdf -- 10/50 50/150
// Prints one line per cell and a JSON line per cell (load timings included).
import { chromium } from "playwright-core";

const [base = "https://127.0.0.1:5300", runsArg = "3", ...rest] = process.argv.slice(2);
const runs = Number(runsArg);
const [variantArgs, files, nets] = rest.join(" ").split(" -- ").map((s) => s.split(" ").filter(Boolean));
const variants = variantArgs.map((v) => {
	const [name, build, query = ""] = v.split(":");
	return { name, build, query };
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const api = (path) => fetch(`${base}${path}`).then((r) => r.json().catch(() => null));
const channel = process.env.CHANNEL ?? "chrome";
const angle = process.env.ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader");
const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true, args: ["--enable-gpu", `--use-angle=${angle}`, "--enable-unsafe-swiftshader", "--ignore-certificate-errors"] });
const med = (a) => {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};

async function idle(page) {
	await page.evaluate(() => window.__viewer?.destroy()).catch(() => {});
	await page.goto("about:blank");
	for (let i = 0; i < 300 && Number(await fetch(`${base}/__active`).then((r) => r.text())) > 0; i++) await new Promise((r) => setTimeout(r, 100));
}

async function open(page, url) {
	await page.goto(url);
	await page.waitForFunction(() => window.__marks?.painted !== undefined || window.__errors?.length, null, { timeout: 900000 });
	return page.evaluate(() => ({ marks: { ...window.__marks }, origin: performance.timeOrigin, load: window.__all.find((e) => e.type === "load")?.timings, errors: window.__errors.map((e) => e.message) }));
}

let nonce = 0;
for (const net of nets) {
	const [mbit, rtt] = net.split("/").map(Number);
	for (const file of files) {
		for (const v of variants) {
			const samples = [];
			for (let i = 0; i < runs; i++) {
				const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
				const page = await ctx.newPage();
				// warm the engine (scripts, wasm) unthrottled, as a host that preloads it
				await api("/__config?mbit=0&rtt=0");
				await open(page, `${base}/${v.build}/index.html?preload=1&file=/pdf/links.pdf`);
				await idle(page);
				await api(`/__config?mbit=${mbit}&rtt=${rtt}`);
				await fetch(`${base}/__reset`);
				const at = await open(page, `${base}/${v.build}/index.html?preload=1&${v.query}&file=${file}${encodeURIComponent(`?n=${process.pid}-${nonce++}`)}`);
				const { log, requests } = await api("/__log");
				const paintedEpoch = at.origin + at.marks.painted;
				samples.push({
					painted: at.marks.painted,
					ready: at.marks.ready,
					mb: log.filter(([t]) => t <= paintedEpoch).reduce((s, [, n]) => s + n, 0) / 1048576,
					requests: requests.filter((r) => r.pdf && r.t <= paintedEpoch).length,
					load: at.load,
					errors: at.errors,
				});
				await idle(page);
				await ctx.close();
			}
			const errs = samples.flatMap((s) => s.errors);
			console.log(
				`${mbit}Mbit ${rtt}ms  ${file.padEnd(22)} ${v.name.padEnd(14)} painted ${med(samples.map((s) => s.painted)).toFixed(0).padStart(6)}ms  ready ${med(samples.map((s) => s.ready)).toFixed(0).padStart(6)}ms  ${med(samples.map((s) => s.mb)).toFixed(2)}MB in ${med(samples.map((s) => s.requests))} req${errs.length ? `  ERRORS ${errs.slice(0, 2).join(" | ")}` : ""}`,
			);
			console.log(`JSON ${JSON.stringify({ mbit, rtt, file, variant: v.name, samples })}`);
		}
	}
}
await api("/__config?mbit=0&rtt=0");
await browser.close();
