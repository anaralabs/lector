// Time to first paint at page 1 and at a restored mid-document position, and
// the PDF bytes downloaded before it, on a throttled network, cold and warm.
// Needs bench/serve.mjs running on the built demo (see README "Development").
//   node bench/open-at.mjs <base=https://127.0.0.1:5300> <query> [runs=3] [label]
// e.g. node bench/open-at.mjs https://127.0.0.1:5300 "file=/scan-big.pdf&page=32&top=396&range=1" 3 after
// Env: MBIT, RTT (server throttle for the run), SHOTS=dir (screenshots at first paint and once sizes settle),
// SETTLE=1 (also wait for every page size and report how far the view moved meanwhile).
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://127.0.0.1:5300";
const query = process.argv[3] ?? "file=/scan-big.pdf";
const runs = Number(process.argv[4] ?? 3);
const label = process.argv[5] ?? "";
const mbit = Number(process.env.MBIT ?? 10);
const rtt = Number(process.env.RTT ?? 40);
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const api = (path) => fetch(`${base}${path}`).then((r) => r.json().catch(() => null));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--use-angle=metal", "--ignore-certificate-errors"] });
const med = (a) => {
	const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
	return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};

async function measure(page, tag) {
	await api(`/__config?mbit=${mbit}&rtt=${rtt}`);
	await fetch(`${base}/__reset`);
	const errors = [];
	const onError = (e) => errors.push(String(e).slice(0, 200));
	page.on("pageerror", onError);
	await page.goto(`${base}/?${query}`);
	await page.waitForFunction(() => window.__marks?.painted !== undefined || window.__errors?.length, null, { timeout: 900000 });
	const at = await page.evaluate(() => ({ marks: { ...window.__marks }, origin: performance.timeOrigin, track: { ...window.__track }, err: window.__errors?.map((e) => e.message) }));
	if (shots) await page.screenshot({ path: `${shots}/${label}-${tag}-painted.png` });
	const { log, requests } = await api("/__log");
	const paintedEpoch = at.origin + at.marks.painted;
	const before = log.filter(([t]) => t <= paintedEpoch).reduce((s, [, n]) => s + n, 0);
	const reqBefore = requests.filter((r) => r.t <= paintedEpoch).length;
	let settle = null;
	if (process.env.SETTLE === "1") {
		await page.waitForFunction(() => window.__marks?.ready !== undefined && (window.__marks["ready-estimated"] === undefined || window.__marks["layout-complete"] !== undefined), null, { timeout: 900000 });
		await page.waitForTimeout(1500);
		const s = await page.evaluate(() => ({ marks: { ...window.__marks }, track: { ...window.__track } }));
		if (shots) await page.screenshot({ path: `${shots}/${label}-${tag}-settled.png` });
		settle = { completeMs: s.marks["layout-complete"] ?? s.marks.ready, first: s.track.first, spread: s.track.max - s.track.min, samples: s.track.samples };
	}
	page.off("pageerror", onError);
	return { ready: at.marks.ready, painted: at.marks.painted, mb: before / 1048576, requests: reqBefore, settle, errors: [...errors, ...(at.err ?? [])] };
}

const cold = [];
const warm = [];
for (let i = 0; i < runs; i++) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
	const page = await ctx.newPage();
	cold.push(await measure(page, `cold${i}`));
	warm.push(await measure(page, `warm${i}`));
	await ctx.close();
}
await api("/__config?mbit=0&rtt=0");
const row = (name, a) => {
	const s = a.map((x) => x.settle).filter(Boolean);
	const settle = s.length ? `  sizes done ${med(s.map((x) => x.completeMs)).toFixed(0)}ms  view moved ${Math.max(...s.map((x) => x.spread)).toFixed(2)}pt` : "";
	const errs = a.flatMap((x) => x.errors);
	return `${name}: ready ${med(a.map((x) => x.ready)).toFixed(0)}ms  painted ${med(a.map((x) => x.painted)).toFixed(0)}ms  pdf before paint ${med(a.map((x) => x.mb)).toFixed(2)}MB in ${med(a.map((x) => x.requests))} req${settle}${errs.length ? `  ERRORS ${errs.slice(0, 3).join(" | ")}` : ""}`;
};
console.log(`${label} ${query} @${mbit}Mbit/s rtt ${rtt}ms (median of ${runs})`);
console.log(`  ${row("cold", cold)}`);
console.log(`  ${row("warm", warm)}`);
console.log(`JSON ${JSON.stringify({ label, query, mbit, rtt, cold, warm })}`);
await browser.close();
