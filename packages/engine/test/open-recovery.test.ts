// Opens synthetic non-linearized PDFs in Chromium over a Range server (built package: run after `pnpm build`).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

// @ts-expect-error plain .mjs fixture, no types
const { makeUnlinearized } = await import("./fixtures/make-unlinearized.mjs");

const MB = 1024 * 1024;
const dist = new URL("../dist/", import.meta.url);
const files = new Map<string, Uint8Array>();
/** path -> the version served once the first request for it was answered (an object rewritten in place) */
const rewritten = new Map<string, Uint8Array>();
const served = new Set<string>();

function pdf(o: { pages: number; bytes: number; xrefStream?: boolean; updates?: number; preamble?: number }): Uint8Array {
	return makeUnlinearized(o);
}

files.set("/big.pdf", pdf({ pages: 30, bytes: 8 * MB + 512 * 1024 }));
files.set("/swap-classic.pdf", pdf({ pages: 30, bytes: 8 * MB + 512 * 1024, updates: 1 }));
rewritten.set("/swap-classic.pdf", pdf({ pages: 32, bytes: 11 * MB, updates: 1 }));
files.set("/swap-xrefstm.pdf", pdf({ pages: 40, bytes: 12 * MB, xrefStream: true, updates: 3 }));
rewritten.set("/swap-xrefstm.pdf", pdf({ pages: 42, bytes: 15 * MB, xrefStream: true }));
files.set("/preamble.pdf", pdf({ pages: 6, bytes: 600 * 1024, preamble: 4096 }));
files.set("/preamble-big.pdf", pdf({ pages: 20, bytes: 9 * MB, xrefStream: true, preamble: 70000 }));
files.set("/not-a-pdf.pdf", new TextEncoder().encode("Service unavailable\n".repeat(40)));

const page = `<!doctype html><div id="v" style="width:800px;height:600px"></div><script type="module">
import { createViewer } from "/app/index.js";
window.open = async (src, rangeLoading) => {
	const errors = [];
	try {
		const source = src.startsWith("bytes:") ? await (await fetch(src.slice(6))).arrayBuffer() : src;
		const v = await createViewer(document.getElementById("v"), source, {
			wasmUrl: "/app/pdfium.wasm",
			workerUrls: { raster: "/app/raster-worker.js", core: "/app/core-worker.js" },
			rangeLoading,
			onEvent: (e) => e.type === "error" && errors.push(e.code + ": " + e.message),
		});
		const { info } = await v.loaded;
		const text = await v.pageText(0);
		v.destroy();
		return { pages: info.pageCount, text, errors };
	} catch (e) {
		return { failed: (e && e.code) + ": " + ((e && e.message) || e), errors };
	}
};
</script>`;

function sendPdf(req: IncomingMessage, res: ServerResponse, path: string) {
	const next = rewritten.get(path);
	const bytes = served.has(path) && next ? next : files.get(path)!;
	served.add(path);
	const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
	const headers = { "content-type": "application/pdf", "accept-ranges": "bytes", "cache-control": "no-store" };
	if (!range) {
		res.writeHead(200, { ...headers, "content-length": bytes.length });
		return res.end(bytes);
	}
	const start = Number(range[1]);
	const end = Math.min(bytes.length, range[2] ? Number(range[2]) + 1 : bytes.length);
	if (start >= bytes.length) return res.writeHead(416, { "content-range": `bytes */${bytes.length}` }).end();
	res.writeHead(206, { ...headers, "content-length": end - start, "content-range": `bytes ${start}-${end - 1}/${bytes.length}` });
	res.end(bytes.subarray(start, end));
}

const server = createServer(async (req, res) => {
	const path = new URL(req.url ?? "/", "http://x").pathname;
	if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
	if (files.has(path)) return sendPdf(req, res, path);
	if (path.startsWith("/app/")) {
		try {
			const name = path.slice(5).replace(/[^\w.-]/g, "");
			const type = name.endsWith(".wasm") ? "application/wasm" : "text/javascript";
			return res.writeHead(200, { "content-type": type }).end(await readFile(new URL(name, dist)));
		} catch {}
	}
	res.writeHead(404).end();
});

type Opened = { pages?: number; text?: string; failed?: string; errors: string[] };
type Page = { goto(url: string): Promise<unknown>; evaluate<T, A>(fn: (a: A) => T | Promise<T>, arg: A): Promise<T> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
let browser: Browser | null = null;
let skip: string | false = false;
let base = "";

before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const { chromium } = await import("playwright-core");
		browser = (await chromium
			.launch({ channel: "chrome", headless: true })
			.catch(() => chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] }))) as unknown as Browser;
	} catch (err) {
		skip = `no browser: ${String((err as Error)?.message ?? err).split("\n")[0]}`;
	}
});

after(async () => {
	await browser?.close();
	server.close();
});

async function open(src: string, rangeLoading = true): Promise<Opened> {
	served.clear();
	const page = await browser!.newPage();
	await page.goto(`${base}/`);
	return page.evaluate(([s, r]) => (window as unknown as { open(s: string, r: boolean): Promise<Opened> }).open(s, r), [src, rangeLoading] as [string, boolean]);
}

test("an 8 MiB+ non-linearized file opens from range reads", async (t) => {
	if (skip) return t.skip(skip);
	const r = await open("/big.pdf");
	assert.equal(r.failed, undefined);
	assert.equal(r.pages, 30);
	assert.match(r.text!, /Page 1/);
});

test("a file rewritten in place while range reads open it opens from one whole download", async (t) => {
	if (skip) return t.skip(skip);
	for (const [path, before, now] of [["/swap-classic.pdf", 30, 32], ["/swap-xrefstm.pdf", 40, 42]] as const) {
		const r = await open(path);
		assert.equal(r.failed, undefined, path);
		assert.deepEqual(r.errors, [], path);
		// one version or the other, never a mix of the two
		assert.ok(r.pages === before || r.pages === now, `${path}: ${r.pages} pages`);
	}
});

test("a header past PDFium's first KB opens, from range reads and from memory", async (t) => {
	if (skip) return t.skip(skip);
	for (const [src, ranged] of [["/preamble.pdf", true], ["bytes:/preamble.pdf", false], ["/preamble-big.pdf", true]] as const) {
		const r = await open(src, ranged);
		assert.equal(r.failed, undefined, src);
		assert.match(r.text!, /Page 1/, src);
	}
});

test("bytes that are no PDF still fail as a parse error, with their shape", async (t) => {
	if (skip) return t.skip(skip);
	const r = await open("/not-a-pdf.pdf");
	assert.match(r.failed!, /^parse: /);
});
