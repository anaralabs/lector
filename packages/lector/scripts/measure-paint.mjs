import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories = {
	"/pdf/": resolve(root, "../docs/public/pdf"),
	"/pdfjs/": resolve(root, "node_modules/pdfjs-dist"),
	"/": resolve(root, "benchmarks/reader/dist"),
};
const mime = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".pdf": "application/pdf",
	".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
	try {
		const path = decodeURIComponent(
			new URL(request.url, "http://localhost").pathname,
		);
		const prefix = Object.keys(directories).find((prefix) =>
			path.startsWith(prefix),
		);
		const directory = directories[prefix];
		const file = resolve(directory, path.slice(prefix.length) || "index.html");
		if (!file.startsWith(directory + sep)) {
			response.writeHead(403).end();
			return;
		}
		const { size } = await stat(file);
		const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
		const start = range ? Number(range[1]) : 0;
		const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start >= size || end < start) {
			response.writeHead(416).end();
			return;
		}
		response.writeHead(range ? 206 : 200, {
			"Content-Type": mime[extname(file)] || "application/octet-stream",
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			"Cache-Control": "no-store",
			...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
		});
		if (request.method === "HEAD") response.end();
		else {
			const stream = createReadStream(file, { start, end });
			response.on("close", () => stream.destroy());
			stream.pipe(response);
		}
	} catch {
		response.writeHead(404).end();
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
async function freshContext() {
	await browser?.close();
	browser = await chromium.launch({
		channel: process.env.LECTOR_BROWSER_CHANNEL || "chrome",
	});
	return browser.newContext({
		viewport: { width: 800, height: 650 },
		deviceScaleFactor: 1,
	});
}
const trials = Number(process.env.LECTOR_PAINT_TRIALS) || 3;
const mode = process.env.LECTOR_PAINT_MODE || "scroll";
const cpuRate = Number(process.env.LECTOR_PAINT_CPU) || 6;
const rows = [];
try {
	const scenarios =
		mode === "lifecycle"
			? []
			: mode === "cold"
				? [
						{ pdf: "large", page: 1 },
						{ pdf: "large", page: 200 },
						{ pdf: "expensive", page: 1, dark: 1 },
					]
				: [
						{ pdf: "large", page: 1 },
						{ pdf: "expensive", page: 1, dark: 1 },
					];
	for (const scenario of scenarios)
		for (let trial = 0; trial < trials; trial++) {
			const context = await freshContext();
			try {
				const page = await context.newPage();
				const errors = [];
				page.on("pageerror", (error) => errors.push(String(error)));
				const cdp = await context.newCDPSession(page);
				const pdfRequests = new Set();
				const pendingResources = new Map();
				let pdfBytesBeforeReady = 0;
				await cdp.send("Network.enable");
				cdp.on("Network.requestWillBeSent", (event) => {
					pendingResources.set(event.requestId, event.request.url);
					if (new URL(event.request.url).pathname.startsWith("/pdf/"))
						pdfRequests.add(event.requestId);
				});
				cdp.on("Network.loadingFinished", (event) =>
					pendingResources.delete(event.requestId),
				);
				cdp.on("Network.loadingFailed", (event) =>
					pendingResources.delete(event.requestId),
				);
				cdp.on("Network.dataReceived", (event) => {
					if (pdfRequests.has(event.requestId))
						pdfBytesBeforeReady += event.encodedDataLength;
				});
				await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
				if (mode === "cold") {
					await cdp.send("Network.enable");
					await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
					await cdp.send("Network.emulateNetworkConditions", {
						offline: false,
						latency: 80,
						downloadThroughput: 750000,
						uploadThroughput: 250000,
					});
				}
				await page.goto(
					`http://127.0.0.1:${server.address().port}/?${new URLSearchParams({ ...scenario, ...(process.env.LECTOR_PAINT_RANGE === "1" ? { range: "1" } : {}) })}`,
					{ waitUntil: "domcontentloaded", timeout: 60000 },
				);
				try {
					await page.waitForFunction(
						() => window.lectorBenchmark?.metrics.firstCanvasMs > 0,
						undefined,
						{ timeout: 60000 },
					);
				} catch (error) {
					console.error(
						JSON.stringify({
							scenario,
							trial,
							errors,
							pdfRequests: pdfRequests.size,
							pendingResources: [...pendingResources.values()],
							pdfBytesBeforeReady,
							state: await page.evaluate(() => ({
								metrics: window.lectorBenchmark?.metrics,
								text: document.body.innerText,
							})),
						}),
					);
					throw error;
				}
				const loading = await page.evaluate(() => ({
					...window.lectorBenchmark.metrics,
					firstContentfulPaintMs: performance.getEntriesByName(
						"first-contentful-paint",
					)[0]?.startTime,
				}));
				const network = { pdfBytesBeforeReady, pdfRequests: pdfRequests.size };
				const scroll =
					mode === "scroll"
						? await page.evaluate(() => window.lectorBenchmark.scroll())
						: undefined;
				assert.deepEqual(
					errors,
					[],
					"The reader should not throw during the measured interaction",
				);
				assert.deepEqual(
					loading.errors,
					[],
					"The measured document should load successfully",
				);
				const row = { scenario, trial, loading, network, scroll, errors };
				rows.push(row);
				console.log(JSON.stringify(row));
			} finally {
				await context.close();
			}
		}
	if (mode === "lifecycle") {
		for (let trial = 0; trial < trials; trial++) {
			const context = await freshContext();
			try {
				const page = await context.newPage();
				const cdp = await context.newCDPSession(page);
				const pending = new Set();
				let resolveRequest;
				const request = new Promise((resolve) => {
					resolveRequest = resolve;
				});
				const aborted = new Set();
				await cdp.send("Network.enable");
				await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
				await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
				await cdp.send("Network.emulateNetworkConditions", {
					offline: false,
					latency: 80,
					downloadThroughput: 750000,
					uploadThroughput: 250000,
				});
				cdp.on("Network.requestWillBeSent", (event) => {
					if (event.request.url.endsWith("/pdf/large.pdf")) {
						pending.add(event.requestId);
						resolveRequest();
					}
				});
				cdp.on("Network.loadingFinished", (event) =>
					pending.delete(event.requestId),
				);
				cdp.on("Network.loadingFailed", (event) => {
					if (pending.has(event.requestId) && event.canceled)
						aborted.add(event.requestId);
				});

				await page.goto(
					`http://127.0.0.1:${server.address().port}/?pdf=large`,
					{ waitUntil: "domcontentloaded" },
				);
				let requestTimer;
				try {
					await Promise.race([
						request,
						new Promise((_, reject) => {
							requestTimer = setTimeout(
								() => reject(new Error("PDF request did not start")),
								60000,
							);
						}),
					]);
				} finally {
					clearTimeout(requestTimer);
				}
				const activeRequests = new Set(pending);
				const switchedAt = await page.evaluate(() => {
					const now = performance.now();
					window.lectorBenchmark.replace("/pdf/form.pdf");
					return now;
				});
				await page.waitForFunction(
					() => window.lectorBenchmark.metrics.firstCanvasMs > 0,
					undefined,
					{ timeout: 60000 },
				);
				const replacement = await page.evaluate(() => ({
					...window.lectorBenchmark.metrics,
					source: window.lectorBenchmark.currentSource,
					pages: window.lectorBenchmark.currentDocument(),
				}));
				assert.equal(replacement.source, "/pdf/form.pdf");
				assert.equal(
					replacement.pages,
					replacement.documentLoads.at(-1).numPages,
				);
				assert.deepEqual(replacement.errors, []);
				const abortDeadline = Date.now() + 5000;
				while (
					![...activeRequests].some((id) => aborted.has(id)) &&
					Date.now() < abortDeadline
				)
					await new Promise((resolve) => setTimeout(resolve, 20));
				assert.ok(
					[...activeRequests].some((id) => aborted.has(id)),
					"The in-flight old download should be aborted",
				);
				await page.evaluate(() => window.lectorBenchmark.unmount());
				const cleanupDeadline = Date.now() + 5000;
				while (page.workers().length && Date.now() < cleanupDeadline)
					await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(
					page.workers().length,
					0,
					"Reader unmount should release its worker",
				);
				const row = {
					workerReleased: true,
					trial,
					switchToCanvasMs: replacement.firstCanvasMs - switchedAt,
					oldDownloadAborted: true,
					replacement,
				};
				rows.push(row);
				// Error feedback is a correctness check, outside the timed cold replacement.
				await cdp.send("Network.emulateNetworkConditions", {
					offline: false,
					latency: 0,
					downloadThroughput: -1,
					uploadThroughput: -1,
				});
				await page.goto(
					`http://127.0.0.1:${server.address().port}/?pdf=missing`,
					{ waitUntil: "domcontentloaded" },
				);
				await page.waitForFunction(
					() => window.lectorBenchmark?.metrics.errors.length > 0,
					undefined,
					{ timeout: 30000 },
				);
				await page.waitForTimeout(100);
				row.errorFeedback = {
					alert: (await page.getByRole("alert").count()) > 0,
					loading: (await page.getByRole("status").count()) > 0,
				};
				if (process.env.LECTOR_PAINT_BASELINE !== "1") {
					assert.equal(row.errorFeedback.alert, true);
					assert.equal(row.errorFeedback.loading, false);
				}
				console.log(JSON.stringify(row));
			} finally {
				await context.close();
			}
		}
	}
	const result = {
		mode,
		cpuRate,
		browser: browser.version(),
		coldNetwork:
			mode === "cold" || mode === "lifecycle"
				? {
						latencyMs: 80,
						downloadBytesPerSecond: 750000,
						uploadBytesPerSecond: 250000,
					}
				: null,
		rows,
	};
	await writeFile(
		process.env.LECTOR_PAINT_OUTPUT || `/tmp/lector-${mode}-results.json`,
		JSON.stringify(result, null, 2) + "\n",
	);
} finally {
	await browser?.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}
