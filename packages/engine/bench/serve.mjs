// Static server for range-loading benches: HTTP/2 like a CDN, single-range
// requests, server-side throttling (so worker XHRs are throttled too) and a
// log of every PDF byte sent with its time, to count bytes before first paint.
//   node bench/serve.mjs <root> [port=5300]
// Query on the page URL is ignored; control it with these env vars or /__config:
//   MBIT (default 0 = unthrottled), RTT (ms, default 0), RANGES=0 (ignore Range),
//   EXPOSE=0 (no Access-Control-Expose-Headers, like a CDN that hides Content-Range)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import http2 from "node:http2";
import { brotliCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const root = process.argv[2];
const port = Number(process.argv[3] ?? 5300);
const cfg = { mbit: Number(process.env.MBIT ?? 0), rtt: Number(process.env.RTT ?? 0), ranges: process.env.RANGES !== "0", expose: process.env.EXPOSE !== "0" };
const extraRoots = (process.env.EXTRA_ROOTS ?? "").split(",").filter(Boolean);

const certDir = join(tmpdir(), "lector-bench-cert");
if (!existsSync(join(certDir, "key.pem"))) {
	mkdirSync(certDir, { recursive: true });
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=127.0.0.1", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdio: "ignore" });
}

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".pdf": "application/pdf", ".css": "text/css", ".json": "application/json" };

/** every PDF chunk sent: [epoch ms, bytes, path, requestId] */
let log = [];
let requests = [];
let nextId = 1;
/** responses still being written (a page that left must not keep the pipe busy for the next) */
let active = 0;

// One shared pipe: a byte budget refilled at `mbit`, consumed by every response.
let budget = 0;
let last = Date.now();
const waiters = [];
function take(n) {
	if (!cfg.mbit) return Promise.resolve();
	return new Promise((resolve) => {
		waiters.push({ n, resolve });
		pumpPipe();
	});
}
let timer = null;
function pumpPipe() {
	const now = Date.now();
	budget = Math.min(budget + ((now - last) / 1000) * ((cfg.mbit * 1e6) / 8), 64 * 1024);
	last = now;
	while (waiters.length && budget >= Math.min(waiters[0].n, 16 * 1024)) {
		const w = waiters.shift();
		budget -= w.n;
		w.resolve();
	}
	if (waiters.length && !timer) timer = setTimeout(() => ((timer = null), pumpPipe()), 4);
}

const CHUNK = 16 * 1024;
const compressed = new Map();
const brotli = (file) => {
	if (!compressed.has(file)) compressed.set(file, brotliCompressSync(readFileSync(file)));
	return compressed.get(file);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePath(url) {
	const path = decodeURIComponent(url.split("?")[0]);
	if (path === "/") return join(root, "index.html");
	for (const r of [root, ...extraRoots]) {
		const file = normalize(join(r, path));
		if (file.startsWith(normalize(r)) && existsSync(file) && statSync(file).isFile()) return file;
	}
	return null;
}

const server = http2.createSecureServer({ key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")), allowHTTP1: true }, async (req, res) => {
	const url = req.url ?? "/";
	if (url.startsWith("/__config")) {
		const q = new URL(url, "https://x").searchParams;
		for (const k of ["mbit", "rtt"]) if (q.has(k)) cfg[k] = Number(q.get(k));
		for (const k of ["ranges", "expose"]) if (q.has(k)) cfg[k] = q.get(k) !== "0";
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(cfg));
		return;
	}
	if (url.startsWith("/__reset")) {
		log = [];
		requests = [];
		res.end("ok");
		return;
	}
	if (url.startsWith("/__active")) {
		res.end(String(active));
		return;
	}
	if (url.startsWith("/__log")) {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ log, requests }));
		return;
	}
	const origin = req.headers.origin;
	if (origin) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Access-Control-Allow-Headers", "Range");
		if (cfg.expose) res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
	}
	if (req.method === "OPTIONS") {
		res.statusCode = 204;
		res.end();
		return;
	}
	const file = resolvePath(url);
	if (!file) {
		res.statusCode = 404;
		res.end();
		return;
	}
	const isPdf = file.endsWith(".pdf");
	// Like a CDN: scripts and wasm go out brotli-compressed (PDFs never are).
	if (!isPdf && /\bbr\b/.test(req.headers["accept-encoding"] ?? "") && /\.(wasm|js|mjs)$/.test(file)) {
		const body = brotli(file);
		res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
		res.setHeader("Content-Encoding", "br");
		res.setHeader("Cache-Control", "public, max-age=3600");
		res.setHeader("Content-Length", String(body.length));
		requests.push({ id: nextId++, t: Date.now(), pdf: false, path: url.split("?")[0], method: req.method, range: null, bytes: body.length, status: 200 });
		if (cfg.rtt) await sleep(cfg.rtt);
		for (let pos = 0; pos < body.length; pos += CHUNK) {
			const chunk = body.subarray(pos, pos + CHUNK);
			await take(chunk.length);
			if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
		}
		res.end();
		return;
	}
	const size = statSync(file).size;
	res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
	res.setHeader("Cache-Control", "public, max-age=3600");
	res.setHeader("ETag", `"${size}-${statSync(file).mtimeMs}"`);
	let start = 0;
	let end = size;
	const range = cfg.ranges && isPdf ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "") : null;
	if (cfg.ranges && isPdf) res.setHeader("Accept-Ranges", "bytes");
	if (range) {
		if (range[1] === "") start = Math.max(0, size - Number(range[2]));
		else {
			start = Number(range[1]);
			end = range[2] === "" ? size : Math.min(size, Number(range[2]) + 1);
		}
		res.statusCode = 206;
		res.setHeader("Content-Range", `bytes ${start}-${end - 1}/${size}`);
	}
	res.setHeader("Content-Length", String(end - start));
	const id = nextId++;
	requests.push({ id, t: Date.now(), pdf: isPdf, path: url.split("?")[0], method: req.method, range: req.headers.range ?? null, bytes: end - start, status: res.statusCode });
	if (cfg.rtt) await sleep(cfg.rtt);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	const fh = await open(file, "r");
	// a client that cancelled during the round-trip sleep closed the stream before any listener was attached
	const closed = () => res.destroyed || res.stream?.destroyed || res.stream?.closed;
	active++;
	try {
		for (let pos = start; pos < end && !closed(); pos += CHUNK) {
			const n = Math.min(CHUNK, end - pos);
			await take(n);
			const buf = Buffer.alloc(n);
			await fh.read(buf, 0, n, pos);
			if (closed()) break;
			if (!res.write(buf))
				await new Promise((r) => {
					res.once("drain", r);
					res.once("close", r);
				});
			if (isPdf) log.push([Date.now(), n, url.split("?")[0], id]);
		}
	} finally {
		active--;
		await fh.close();
		if (!closed()) res.end();
	}
});
server.listen(port, "127.0.0.1", () => console.log(`bench server https://127.0.0.1:${port} root=${root} ${JSON.stringify(cfg)}`));
