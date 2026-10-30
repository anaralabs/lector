// Packs the package and checks that every export points at a packed file, that
// license notices ship, and that the documented self-hosted worker setup works:
// only raster-worker.js, core-worker.js and pdfium.wasm, served from their own
// directory. Set ENGINE_PACKAGE_BROWSER=1 to require the in-browser boot check
// (otherwise it is skipped when no browser can launch).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "lector-engine-package-"));
try {
	execFileSync("pnpm", ["pack", "--pack-destination", directory], {
		env: { ...process.env, npm_config_ignore_scripts: "true" },
		stdio: "pipe",
	});
	const archive = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
	assert.ok(archive, "pnpm must produce a package archive");
	execFileSync("tar", ["-xzf", join(directory, archive), "-C", directory]);
	const packed = join(directory, "package");
	const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
	assert.equal(manifest.private, undefined, "package must not be private");
	const targets = Object.values(manifest.exports).flatMap((t) => (typeof t === "string" ? [t] : Object.values(t)));
	for (const target of targets) await stat(join(packed, target));
	// Worker URLs in the viewer must point at the published .js files.
	const chunks = (await readdir(join(packed, "dist"))).filter((f) => f.endsWith(".js"));
	const code = (await Promise.all(chunks.map((f) => readFile(join(packed, "dist", f), "utf8")))).join("\n");
	assert.match(code, /new URL\("\.\/raster-worker\.js", import\.meta\.url\)/);
	assert.match(code, /new URL\("\.\/core-worker\.js", import\.meta\.url\)/);
	assert.doesNotMatch(code, /"\.\/(raster|core)-worker\.ts"/);
	const { size } = await stat(join(packed, "dist/pdfium.wasm"));
	assert.ok(size > 1_000_000, "pdfium.wasm must be packed");

	// PDFium and EmbedPDF ship under their own licenses.
	for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "dist/LICENSE.pdfium", "dist/LICENSE.embedpdf"]) {
		assert.ok((await stat(join(packed, file))).size > 0, `${file} must be packed`);
	}
	assert.match(await readFile(join(packed, "dist/LICENSE.pdfium"), "utf8"), /PDFium Authors/);
	assert.match(await readFile(join(packed, "dist/LICENSE.embedpdf"), "utf8"), /MIT License/);

	// Workers are standalone: no static or dynamic imports of sibling files.
	for (const worker of ["raster-worker.js", "core-worker.js"]) {
		const source = await readFile(join(packed, "dist", worker), "utf8");
		assert.doesNotMatch(source, /(?:\bimport\b|\bexport\b)[^;'"]*?from\s*["']\.{1,2}\//, `${worker} must not import sibling chunks`);
		assert.doesNotMatch(source, /\bimport\(\s*["']\.{1,2}\//, `${worker} must not import sibling chunks`);
	}

	const booted = await selfHost(packed);
	console.info(`Packed ${targets.length} export targets; worker URLs, pdfium.wasm, license notices OK; self-hosted workers: ${booted}.`);
} finally {
	await rm(directory, { recursive: true, force: true });
}

/**
 * Serves the documented files alone under /assets/ (the README's self-hosted
 * setup) and the package's main bundle under /app/, then opens a PDF.
 */
async function selfHost(packed) {
	const root = join(directory, "site");
	await mkdir(join(root, "assets"), { recursive: true });
	await mkdir(join(root, "app"), { recursive: true });
	for (const file of ["raster-worker.js", "core-worker.js", "pdfium.wasm"]) await copyFile(join(packed, "dist", file), join(root, "assets", file));
	for (const file of await readdir(join(packed, "dist"))) if (file.endsWith(".js") && !file.includes("worker")) await copyFile(join(packed, "dist", file), join(root, "app", file));
	const { PDFDocument, StandardFonts } = createRequire(import.meta.url)("pdf-lib");
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (let i = 1; i <= 3; i++) pdf.addPage([612, 792]).drawText(`Self-hosted workers, page ${i}`, { x: 72, y: 700, size: 18, font });
	await writeFile(join(root, "doc.pdf"), await pdf.save());
	await writeFile(
		join(root, "index.html"),
		`<!doctype html><div id="v" style="width:800px;height:600px"></div><script type="module">
import { createViewer } from "/app/index.js";
window.result = (async () => {
	const errors = [];
	const v = await createViewer(document.getElementById("v"), "/doc.pdf", {
		wasmUrl: "/assets/pdfium.wasm",
		workerUrls: { raster: "/assets/raster-worker.js", core: "/assets/core-worker.js" },
		onEvent: (e) => e.type === "error" && errors.push(e.code + ": " + e.message),
	});
	const { info } = await v.loaded;
	const text = await v.pageText(0);
	v.destroy();
	return { pages: info.pageCount, text: text.length, offscreen: v.offscreen, errors };
})().catch((e) => ({ failed: String((e && e.message) || e) }));
</script>`,
	);
	const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".pdf": "application/pdf" };
	const requested = [];
	const server = createServer(async (req, res) => {
		const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
		requested.push(path);
		try {
			const file = path === "." || !path ? "index.html" : path;
			const body = await readFile(join(root, file));
			res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
			res.end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${server.address().port}/`;
	let browser;
	try {
		const { chromium } = await import("playwright-core");
		// Chrome if installed, else Playwright's Chromium (software WebGL on CI).
		browser = await chromium
			.launch({ channel: "chrome", headless: true })
			.catch(() => chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] }));
	} catch (err) {
		server.close();
		if (process.env.ENGINE_PACKAGE_BROWSER === "1") throw err;
		return `skipped (no browser: ${String(err?.message ?? err).split("\n")[0]})`;
	}
	try {
		const page = await browser.newPage();
		await page.goto(url);
		const result = await page.waitForFunction(() => window.result, null, { timeout: 30000 }).then((h) => h.jsonValue());
		const documented = /^(app\/.*|index\.html|doc\.pdf|favicon\.ico|assets\/(raster-worker\.js|core-worker\.js|pdfium\.wasm))?$/;
		const extra = requested.filter((p) => !documented.test(p));
		assert.deepEqual(extra, [], `self-hosting requested files beyond the documented ones: ${extra.join(", ")}`);
		if (result.failed?.includes("not supported in this browser") && process.env.ENGINE_PACKAGE_BROWSER !== "1") return `skipped (${result.failed})`;
		assert.ok(!result.failed, `self-hosted viewer failed: ${result.failed}`);
		assert.equal(result.pages, 3);
		assert.ok(result.text > 20, "page text extracted");
		assert.deepEqual(result.errors.filter((e) => e.startsWith("worker")), [], "workers load");
		if (result.offscreen) assert.ok(requested.includes("assets/core-worker.js"), "the compositor worker loads");
		return `booted (${result.pages} pages, ${result.offscreen ? "worker" : "main-thread"} compositor)`;
	} finally {
		await browser.close();
		server.close();
	}
}
