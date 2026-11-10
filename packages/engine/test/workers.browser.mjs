// Worker start failures in real browsers against dist/ (pnpm build first); BROWSERS=chromium,webkit,firefox.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, webkit, firefox } from "playwright-core";

const dist = new URL("../dist/", import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), "lector-worker-start-"));
await mkdir(join(root, "assets"));
await mkdir(join(root, "app"));
for (const file of ["raster-worker.js", "core-worker.js", "pdfium.wasm"]) await copyFile(join(dist, file), join(root, "assets", file));
for (const file of await readdir(dist)) if (file.endsWith(".js") && !file.includes("worker")) await copyFile(join(dist, file), join(root, "app", file));
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)("pdf-lib");
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 4; i++) pdf.addPage([612, 792]).drawText(`Worker start, page ${i}`, { x: 72, y: 700, size: 18, font });
await writeFile(join(root, "doc.pdf"), await pdf.save());

await writeFile(
	join(root, "index.html"),
	`<!doctype html><body style="margin:0"><div id="v" style="width:800px;height:600px"></div><script type="module">
import { createViewer } from "/app/index.js";
const q = new URLSearchParams(location.search);
const deadRaster = new Set((q.get("deadRaster") ?? "").split(",").filter(Boolean));
const loader = q.get("loader");
const classicLoader = (url) => URL.createObjectURL(new Blob(["importScripts(" + JSON.stringify(url) + ");"], { type: "text/javascript" }));
const moduleLoader = (url) => URL.createObjectURL(new Blob(["import(" + JSON.stringify(url) + ").catch(function (e) { setTimeout(function () { throw e; }); });"], { type: "text/javascript" }));
const types = [];
const createWorker = (url, name, options) => {
	types.push(options?.type);
	if (deadRaster.has(name)) url = new URL("/assets/missing-" + name + ".js", location.href);
	if (loader) return new Worker((options?.type === "classic" ? classicLoader : moduleLoader)(url.href), { name });
	return new Worker(url, { type: options?.type ?? "module", name });
};
window.result = (async () => {
	const errors = [];
	const v = await createViewer(document.getElementById("v"), "/doc.pdf", {
		wasmUrl: "/assets/pdfium.wasm",
		workerUrls: { raster: "/assets/raster-worker.js", core: "/assets/core-worker.js" },
		workers: Number(q.get("workers") ?? 2),
		createWorker: q.get("factory") === "0" ? undefined : createWorker,
		onEvent: (e) => e.type === "error" && errors.push(e.code + ": " + e.message),
	});
	const { info } = await v.loaded;
	const text = await v.pageText(info.pageCount - 1);
	const offscreen = v.offscreen;
	v.destroy();
	return { pages: info.pageCount, text, offscreen, errors, types };
})().catch((e) => ({ failed: String((e && e.message) || e), code: e && e.code }));
</script>`,
);

const mime = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".pdf": "application/pdf" };
let requested = [];
/** path -> how many more requests to drop (Infinity: always) */
let drop = new Map();
const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	const path = url.pathname.replace(/^\/+/, "") || "index.html";
	requested.push(path + url.search);
	const left = drop.get(path) ?? 0;
	if (left > 0) {
		drop.set(path, left - 1);
		// an error status: a reset socket is retried by the browser itself
		res.writeHead(503).end();
		return;
	}
	try {
		const body = await readFile(join(root, path));
		res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
		res.end(body);
	} catch {
		res.writeHead(404).end();
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

// Firefox before 114 and some managed Chrome builds: `type: "module"` is refused, the option is never read by the probe.
const noModuleWorkers = () => {
	const Native = Worker;
	globalThis.Worker = class extends Native {
		constructor(url, options = {}) {
			const d = Object.getOwnPropertyDescriptor(options, "type");
			if (d && "value" in d && d.value === "module") throw new TypeError("Module scripts are not supported on DedicatedWorker yet.");
			super(url, { name: options.name });
		}
	};
};

const cases = [
	{
		name: "a dropped worker fetch is retried from a fresh URL",
		query: "workers=1",
		drop: { "assets/raster-worker.js": 2, "assets/core-worker.js": 1 },
		check: (r) => {
			assert.equal(r.pages, 4);
			assert.deepEqual(r.errors, []);
			const raster = requested.filter((p) => p.startsWith("assets/raster-worker.js"));
			assert.equal(raster.length, 3, raster.join(", "));
			assert.match(raster[1], /lector-retry=1-/);
			assert.match(raster[2], /lector-retry=2-/);
		},
	},
	{
		name: "a raster worker that never loads leaves the others to open the document",
		query: "workers=3&deadRaster=lector-raster-0",
		check: (r) => {
			assert.equal(r.pages, 4);
			assert.match(r.text, /page 4/);
			assert.deepEqual(r.errors, []);
		},
	},
	{
		name: "no raster worker loads: the document fails with `worker`",
		query: "workers=2&deadRaster=lector-raster-0,lector-raster-1",
		check: (r) => {
			assert.equal(r.code, "worker", JSON.stringify(r));
			assert.equal(requested.filter((p) => p.startsWith("assets/missing-lector-raster-0")).length, 3);
		},
	},
	{
		name: "the compositor worker never loads: it composites on the main thread",
		query: "workers=2",
		drop: { "assets/core-worker.js": Infinity },
		check: (r, { offscreenCapable }) => {
			assert.equal(r.pages, 4, JSON.stringify(r));
			assert.match(r.text, /page 4/);
			assert.deepEqual(r.errors, []);
			assert.equal(r.offscreen, false);
			if (offscreenCapable) assert.equal(requested.filter((p) => p.startsWith("assets/core-worker.js")).length, 3);
		},
	},
	{
		name: "without module workers the engine starts classic workers (direct URLs)",
		query: "workers=2&factory=0",
		init: noModuleWorkers,
		check: (r) => {
			assert.equal(r.pages, 4, JSON.stringify(r));
			assert.match(r.text, /page 4/);
			assert.deepEqual(r.errors, []);
		},
	},
	{
		name: "without module workers a host factory gets type classic (importScripts loader)",
		query: "workers=2&loader=1",
		init: noModuleWorkers,
		check: (r) => {
			assert.equal(r.pages, 4, JSON.stringify(r));
			assert.deepEqual(r.errors, []);
			assert.ok(r.types.length >= 2 && r.types.every((t) => t === "classic"), r.types.join());
		},
	},
	{
		name: "module workers through a blob loader still work",
		query: "workers=2&loader=1",
		check: (r) => {
			assert.equal(r.pages, 4, JSON.stringify(r));
			assert.deepEqual(r.errors, []);
			assert.ok(r.types.every((t) => t === "module"), r.types.join());
		},
	},
];

const launchers = { chromium, webkit, firefox };
const names = (process.env.BROWSERS ?? "chromium,webkit").split(",");
let failed = 0;
try {
	for (const name of names) {
		const browser = await launchers[name].launch({ headless: true, args: name === "chromium" ? ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] : [] });
		try {
			for (const c of cases) {
				const page = await browser.newPage();
				if (c.init) await page.addInitScript(c.init);
				requested = [];
				drop = new Map(Object.entries(c.drop ?? {}));
				const t0 = Date.now();
				try {
					await page.goto(`${base}?${c.query}`);
					const r = await page.waitForFunction(() => window.result, null, { timeout: 30000 }).then((h) => h.jsonValue());
					const offscreenCapable = await page.evaluate(() => typeof OffscreenCanvas !== "undefined" && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function");
					c.check(r, { offscreenCapable });
					console.info(`ok   ${name}: ${c.name} (${Date.now() - t0} ms)`);
				} catch (err) {
					failed++;
					console.error(`FAIL ${name}: ${c.name}\n     ${String(err?.message ?? err).split("\n").join("\n     ")}`);
				} finally {
					await page.close();
				}
			}
		} finally {
			await browser.close();
		}
	}
} finally {
	server.close();
	await rm(root, { recursive: true, force: true });
}
if (failed) process.exit(1);
