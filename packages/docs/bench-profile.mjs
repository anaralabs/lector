import { chromium, webkit } from "playwright";

const BASE_URL = process.env.BENCH_URL || "http://localhost:3000";

async function profileBrowser(browserType, label) {
	const browser = await browserType.launch({ headless: false });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 900 },
	});
	const page = await context.newPage();

	await page.goto(`${BASE_URL}/bench`, { waitUntil: "networkidle" });
	await page.waitForSelector('[data-bench-id="pages"]', { timeout: 15000 });
	await page.waitForTimeout(3000);

	const pdfs = [
		{ idx: 0, name: "pathways" },
		{ idx: 4, name: "quantum" },
		{ idx: 2, name: "links" },
	];

	for (const pdf of pdfs) {
		await page.evaluate((i) => window.__bench.selectPdf(i), pdf.idx);
		await page.waitForTimeout(4000);

		const result = await page.evaluate(async () => {
			const el = document.querySelector('[data-bench-id="pages"]');
			if (!el) return { error: "no element" };
			const max = el.scrollHeight - el.clientHeight;

			el.scrollTop = 0;
			await new Promise((r) => setTimeout(r, 500));

			const frameTimes = [];
			let lastFrame = performance.now();
			let recording = true;
			const rafLoop = () => {
				if (!recording) return;
				const now = performance.now();
				frameTimes.push(Math.round((now - lastFrame) * 100) / 100);
				lastFrame = now;
				requestAnimationFrame(rafLoop);
			};
			requestAnimationFrame(rafLoop);

			const longTasks = [];
			let ltObserver;
			try {
				ltObserver = new PerformanceObserver((list) => {
					for (const e of list.getEntries()) {
						longTasks.push(Math.round(e.duration * 10) / 10);
					}
				});
				ltObserver.observe({ entryTypes: ["longtask"] });
			} catch {
				// WebKit may not support longtask observer
			}

			const scrollStart = performance.now();

			for (let i = 0; i <= 30; i++) {
				el.scrollTop = (i / 30) * max;
				await new Promise((r) => setTimeout(r, 60));
			}

			await new Promise((r) => setTimeout(r, 1000));
			recording = false;
			ltObserver?.disconnect();

			const scrollTime = performance.now() - scrollStart;

			const sorted = [...frameTimes].sort((a, b) => a - b);
			const p = (pct) => sorted[Math.ceil((pct / 100) * sorted.length) - 1];
			const dropped = frameTimes.filter((t) => t > 33.3).length;
			const slow = frameTimes.filter((t) => t > 16.7).length;

			const canvases = document.querySelectorAll("canvas");
			let totalPixels = 0;
			let canvasCount = 0;
			canvases.forEach((c) => {
				if (c.width > 0 && c.height > 0) {
					totalPixels += c.width * c.height;
					canvasCount++;
				}
			});

			return {
				scrollTimeMs: Math.round(scrollTime),
				frames: frameTimes.length,
				p50: p(50),
				p95: p(95),
				p99: p(99),
				maxFrame: sorted[sorted.length - 1],
				dropped,
				slow,
				longTasks: longTasks.slice(0, 10),
				longTaskCount: longTasks.length,
				canvasCount,
				totalMegapixels:
					Math.round((totalPixels / 1_000_000) * 10) / 10,
			};
		});

		console.log(`[${label}] ${pdf.name}:`);
		console.log(
			`  frames: ${result.frames}  p50: ${result.p50}ms  p95: ${result.p95}ms  p99: ${result.p99}ms  max: ${result.maxFrame}ms`,
		);
		console.log(
			`  dropped: ${result.dropped}  slow: ${result.slow}  longTasks: ${result.longTaskCount} ${result.longTasks.length > 0 ? JSON.stringify(result.longTasks) : ""}`,
		);
		console.log(
			`  canvases: ${result.canvasCount}  totalMpx: ${result.totalMegapixels}  scrollTime: ${result.scrollTimeMs}ms`,
		);
		console.log();
	}

	await browser.close();
}

async function run() {
	console.log("=== Profiling Chrome (Chromium) ===\n");
	await profileBrowser(chromium, "Chrome");

	console.log("=== Profiling Safari (WebKit) ===\n");
	await profileBrowser(webkit, "WebKit");
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
