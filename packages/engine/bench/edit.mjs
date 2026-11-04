// Editing in the browser: edit -> repaint latency, undo/redo, save time and size, per fixture.
//   node bench/edit.mjs [url=http://127.0.0.1:5231/] [outDir=/tmp/edit-bench] file.pdf...
// Starts nothing: run `pnpm vite demo --port 5231` first. Writes before/after screenshots and the saved PDFs.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [url = "http://127.0.0.1:5231/", out = "/tmp/edit-bench", ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
	headless: true,
	args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const results = [];
for (const file of files) {
	const page = await browser.newPage({ viewport: { width: 1100, height: 1300 }, deviceScaleFactor: 1 });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e.stack || e)));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.goto(`${url}?file=/${file}&edit=1&zoom=fit-width`);
	await page.waitForFunction(() => window.__paintedMs !== undefined, null, { timeout: 60000 });
	await page.waitForTimeout(1500);
	const name = file.replace(/\.pdf$/, "");
	await page.screenshot({ path: `${out}/${name}-before.png` });
	const r = await page.evaluate(async () => {
		const v = window.__viewer;
		const painted = (since) =>
			new Promise((resolve) => {
				const t0 = performance.now();
				const tick = () => {
					const e = window.__all.slice(since).find((x) => x.type === "edit-painted");
					if (e) resolve(e.ms);
					else if (performance.now() - t0 > 15000) resolve(null);
					else setTimeout(tick, 5);
				};
				tick();
			});
		const step = async (label, fn) => {
			const since = window.__all.length;
			const t0 = performance.now();
			try {
				const o = await fn();
				const ms = performance.now() - t0;
				const repaint = o && !o.structure ? await painted(since) : null;
				return { label, ok: true, ms: +ms.toFixed(1), worker: o?.ms ? +o.ms.toFixed(1) : undefined, repaint: repaint === null ? undefined : +repaint.toFixed(1), font: o?.font, widthDelta: o?.widthDelta ? +o.widthDelta.toFixed(1) : undefined };
			} catch (e) {
				return { label, ok: false, error: e.message };
			}
		};
		const objs = await v.pageObjects(0);
		const texts = objs.filter((o) => o.type === "text" && (o.text ?? "").trim().length > 3);
		// the visually biggest visible text line
		const target = texts.filter((o) => !o.invisible).sort((a, b) => b.box[3] - b.box[1] - (a.box[3] - a.box[1]))[0] ?? texts[0];
		const steps = [];
		if (target) steps.push(await step("set-text", () => v.edit({ kind: "set-text", page: 0, obj: target.index, text: `Edited: ${target.text.slice(0, 20)}` })));
		steps.push(await step("add-text", () => v.edit({ kind: "add-text", page: 0, x: 60, y: 40, text: "Added by the editor", size: 16, color: [220, 0, 0] })));
		const victim = (await v.pageObjects(0)).filter((o) => o.type === "image" || o.type === "path").sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))[0];
		if (victim) steps.push(await step(`delete-${victim.type}`, () => v.edit({ kind: "delete-object", page: 0, obj: victim.index })));
		steps.push(await step("undo", () => v.undo()));
		steps.push(await step("redo", () => v.redo()));
		if (target) steps.push(await step("undo-to-set-text (replay)", async () => {
			let o = null;
			for (let i = 0; i < 3; i++) o = await v.undo();
			return o;
		}));
		steps.push(await step("redo-all", async () => {
			let o = null;
			for (let i = 0; i < 3; i++) o = (await v.redo()) ?? o;
			return o;
		}));
		const pages = (await v.loaded).pages.length;
		if (pages > 1) steps.push(await step("rotate-page-0", () => v.edit({ kind: "rotate-page", page: 0, quarter: 1 })));
		if (pages > 2) steps.push(await step("delete-page-1", () => v.edit({ kind: "delete-page", page: 1 })));
		const t0 = performance.now();
		const bytes = await v.saveDocument();
		const saveMs = performance.now() - t0;
		let s = "";
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { steps, saveMs: +saveMs.toFixed(1), savedKB: Math.round(bytes.length / 1024), b64: btoa(s), workers: window.__events.at(-1)?.stats.workers };
	});
	await page.waitForTimeout(1200);
	await page.screenshot({ path: `${out}/${name}-after.png` });
	writeFileSync(`${out}/${name}.edited.pdf`, Buffer.from(r.b64, "base64"));
	delete r.b64;
	const row = { file, ...r, errors: errors.slice(0, 3) };
	results.push(row);
	console.log(JSON.stringify(row));
	await page.close();
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
