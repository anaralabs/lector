// GPU context loss in real browsers against dist/ (pnpm build first); BROWSERS=chromium,webkit.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, webkit } from "playwright-core";

const dist = new URL("../dist/", import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), "lector-context-loss-"));
await mkdir(join(root, "assets"));
await mkdir(join(root, "app"));
for (const file of ["raster-worker.js", "core-worker.js", "pdfium.wasm"]) await copyFile(join(dist, file), join(root, "assets", file));
for (const file of await readdir(dist)) if (file.endsWith(".js") && !file.includes("worker")) await copyFile(join(dist, file), join(root, "app", file));
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)("pdf-lib");
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) pdf.addPage([612, 792]).drawText(`Context loss, page ${i}`, { x: 72, y: 700, size: 18, font });
await writeFile(join(root, "doc.pdf"), await pdf.save());

await writeFile(
	join(root, "index.html"),
	`<!doctype html><body style="margin:0"><div id="v" style="width:800px;height:600px"></div><script type="module">
import { createViewer } from "/app/index.js";
const q = new URLSearchParams(location.search);
globalThis.__lectorEngineDebug = true;
window.events = [];
window.ready = (async () => {
	const v = await createViewer(document.getElementById("v"), "/doc.pdf", {
		wasmUrl: "/assets/pdfium.wasm",
		workerUrls: { raster: "/assets/raster-worker.js", core: "/assets/core-worker.js" },
		workers: 1,
		offscreen: q.get("offscreen") !== "0",
		compositor: q.get("compositor") ?? "auto",
		onEvent: (e) => {
			if (e.type === "error" || e.type === "compositor" || e.type === "restored") window.events.push(e.type === "error" ? "error:" + e.code + ": " + e.message : e.type + (e.kind ? ":" + e.kind + ":" + e.reason : ""));
		},
	});
	await v.loaded;
	window.viewer = v;
	return v.offscreen;
})().catch((e) => "failed: " + String((e && e.message) || e));
</script>`,
);

const mime = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".pdf": "application/pdf" };
const server = createServer(async (req, res) => {
	const path = new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "index.html";
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

/** Runs `fn` against the core, wherever it lives (`__core` in the compositor worker or the page). */
async function onCore(page, offscreen, fn, arg) {
	if (!offscreen) return page.evaluate(fn, arg);
	for (const w of page.workers()) {
		const has = await w.evaluate(() => !!self.__core).catch(() => false);
		if (has) return w.evaluate(fn, arg);
	}
	throw new Error("no compositor worker with __core");
}

/** Loses the WebGL context for good: the browser is never asked to restore it. */
const loseWebGL = () => {
	const c = globalThis.__core;
	const gl = c.gl.gl;
	globalThis.__lose = gl.getExtension("WEBGL_lose_context");
	globalThis.__lose.loseContext();
	return c.gl.kind;
};

/** Every 2D canvas the core is handed loses its context right away: a GPU that keeps dropping canvases. */
const lose2dForever = () => {
	const c = globalThis.__core;
	const swap = c.swapCanvas.bind(c);
	c.swapCanvas = (canvas) => {
		swap(canvas);
		queueMicrotask(() => {
			if (c.gl.canvas !== canvas) return;
			c.gl.lost = true;
			c.gl.onLost();
		});
	};
	return true;
};

/** The core's own canvas request never goes out: only the viewer's watchdog can switch. */
const muteCoreRequest = () => {
	globalThis.__core.recovery.request = () => {};
	return true;
};

const kinds = async (page, offscreen) => onCore(page, offscreen, () => globalThis.__core.gl.kind);

const cases = [
	{
		name: "WebGL lost for good: the worker core moves to Canvas 2D and keeps the document",
		query: "offscreen=1&compositor=webgl2",
		run: async (page, offscreen) => {
			await onCore(page, offscreen, loseWebGL);
			await page.waitForFunction(() => window.events.some((e) => e.startsWith("compositor:canvas2d")), null, { timeout: 4000 });
			assert.equal(await kinds(page, offscreen), "canvas2d");
		},
	},
	{
		name: "WebGL lost for good: a main-thread core moves to Canvas 2D and keeps the document",
		query: "offscreen=0&compositor=webgl2",
		run: async (page, offscreen) => {
			assert.equal(offscreen, false);
			await onCore(page, offscreen, loseWebGL);
			await page.waitForFunction(() => window.events.some((e) => e.startsWith("compositor:canvas2d")), null, { timeout: 4000 });
			assert.equal(await kinds(page, offscreen), "canvas2d");
		},
	},
	{
		name: "the core never asks for a canvas: the viewer's watchdog hands one over before hosts give up",
		query: "offscreen=1&compositor=webgl2",
		run: async (page, offscreen) => {
			await onCore(page, offscreen, muteCoreRequest);
			const t0 = Date.now();
			await onCore(page, offscreen, loseWebGL);
			await page.waitForFunction(() => window.events.some((e) => e.startsWith("compositor:canvas2d")), null, { timeout: 4500 });
			assert.ok(Date.now() - t0 < 4500);
			assert.equal(await kinds(page, offscreen), "canvas2d");
		},
	},
	{
		name: "every fresh canvas is lost too: the core still never errors with `compositor`",
		query: "offscreen=1&compositor=webgl2",
		run: async (page, offscreen) => {
			await onCore(page, offscreen, lose2dForever);
			await onCore(page, offscreen, loseWebGL);
			await page.waitForTimeout(9000);
			const events = await page.evaluate(() => window.events);
			assert.ok(!events.some((e) => e.startsWith("error:compositor")), events.join("\n"));
			assert.ok(events.some((e) => e.startsWith("compositor:canvas2d")), events.join("\n"));
		},
	},
];

const launchers = { chromium, webkit };
const names = (process.env.BROWSERS ?? "chromium,webkit").split(",");
const only = process.env.ONLY;
let failed = 0;
try {
	for (const name of names) {
		const browser = await launchers[name].launch({ headless: true, args: name === "chromium" ? ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] : [] });
		try {
			for (const c of cases) {
				if (only && !c.name.includes(only)) continue;
				const page = await browser.newPage();
				const t0 = Date.now();
				try {
					await page.goto(`${base}?${c.query}`);
					const offscreen = await page.waitForFunction(() => window.ready, null, { timeout: 30000 }).then((h) => h.jsonValue());
					assert.equal(typeof offscreen, "boolean", String(offscreen));
					await c.run(page, offscreen);
					console.info(`ok   ${name}: ${c.name} (${Date.now() - t0} ms)`);
				} catch (err) {
					failed++;
					const events = await page.evaluate(() => window.events).catch(() => []);
					console.error(`FAIL ${name}: ${c.name}\n     ${String(err?.message ?? err).split("\n").join("\n     ")}\n     events: ${events.join(" | ")}`);
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
