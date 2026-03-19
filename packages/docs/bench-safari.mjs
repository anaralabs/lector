import { webkit } from "playwright";

const BASE_URL = process.env.BENCH_URL || "http://localhost:3000";
const PDF_COUNT = 5;

function fmtMs(n) {
	return String(Math.round(n * 100) / 100).padStart(8) + "ms";
}
function fmtN(n) {
	return String(n).padStart(6);
}

async function getDomStats(page) {
	return page.evaluate(() => {
		const all = document.querySelectorAll("*").length;
		const tls = document.querySelectorAll(".textLayer");
		let maxChildren = 0;
		let totalSpans = 0;
		tls.forEach((tl) => {
			const n = tl.children.length;
			if (n > maxChildren) maxChildren = n;
			totalSpans += tl.querySelectorAll("span").length;
		});
		return {
			totalElements: all,
			textLayers: tls.length,
			maxTextLayerChildren: maxChildren,
			totalSpans,
		};
	});
}

async function gentleScroll(page) {
	const info = await page.evaluate(() => window.__bench.getScrollInfo());
	if (!info) return null;

	const viewportH = info.clientHeight;
	const totalDistance = Math.min(info.maxScroll, viewportH * 5);
	const steps = 100;
	const delta = totalDistance / steps;

	await page.evaluate(() => window.__bench.scrollTo(0));
	await page.waitForTimeout(200);
	await page.evaluate(() => window.__bench.startFrameRecording());

	for (let i = 0; i < steps; i++) {
		await page.mouse.wheel(0, delta);
		await page.waitForTimeout(50);
	}
	await page.waitForTimeout(300);

	const frames = await page.evaluate(() =>
		window.__bench.stopFrameRecording(),
	);
	return { frames };
}

async function fastFlick(page) {
	const info = await page.evaluate(() => window.__bench.getScrollInfo());
	if (!info) return null;

	const viewportH = info.clientHeight;
	const totalDistance = Math.min(info.maxScroll, viewportH * 20);
	const steps = 40;
	const delta = totalDistance / steps;

	await page.evaluate(() => window.__bench.scrollTo(0));
	await page.waitForTimeout(200);
	await page.evaluate(() => window.__bench.startFrameRecording());

	for (let i = 0; i < steps; i++) {
		await page.mouse.wheel(0, delta);
		await page.waitForTimeout(16);
	}
	await page.waitForTimeout(500);

	const frames = await page.evaluate(() =>
		window.__bench.stopFrameRecording(),
	);
	return { frames };
}

async function scrollStopSelect(page) {
	const info = await page.evaluate(() => window.__bench.getScrollInfo());
	if (!info) return null;

	const viewportH = info.clientHeight;
	const scrollDistance = viewportH * 3;
	const steps = 20;
	const delta = scrollDistance / steps;

	await page.evaluate(() => window.__bench.scrollTo(0));
	await page.waitForTimeout(300);

	for (let i = 0; i < steps; i++) {
		await page.mouse.wheel(0, delta);
		await page.waitForTimeout(30);
	}

	const scrollDone = Date.now();

	let ttts;
	try {
		await page.waitForFunction(
			() => {
				const tls = document.querySelectorAll(".textLayer");
				let ready = 0;
				tls.forEach((tl) => {
					if (tl.querySelectorAll("span").length > 5) ready++;
				});
				return ready >= 2;
			},
			{ timeout: 5000 },
		);
		ttts = Date.now() - scrollDone;
	} catch {
		ttts = -1;
	}

	const status = await page.evaluate(() =>
		window.__bench.getTextLayerStatus(),
	);
	return { ttts, textLayers: status };
}

async function flashDetection(page) {
	await page.evaluate(() => window.__bench.scrollTo(0));
	await page.waitForTimeout(500);

	const results = await page.evaluate(async () => {
		const el = document.querySelector('[data-bench-id="pages"]');
		if (!el) return { error: "no scroll element" };

		const max = el.scrollHeight - el.clientHeight;
		const jumps = [0, 0.9, 0.1, 0.8, 0.3, 0.7, 0.5];
		const snapshots = [];

		for (const ratio of jumps) {
			el.scrollTop = ratio * max;
			await new Promise((r) => requestAnimationFrame(r));
			await new Promise((r) => setTimeout(r, 50));

			const canvases = document.querySelectorAll("canvas");
			let rendered = 0;
			let blank = 0;
			let detailOverlay = 0;
			canvases.forEach((c) => {
				const isDetailOverlay =
					c.parentElement?.classList.contains("absolute") ||
					(c.width === 0 && c.height === 0);
				if (isDetailOverlay) {
					detailOverlay++;
				} else if (c.width > 0 && c.height > 0) {
					rendered++;
				} else {
					blank++;
				}
			});
			snapshots.push({
				scrollRatio: ratio,
				rendered,
				blank,
				detailOverlay,
				total: canvases.length,
			});
		}
		return snapshots;
	});

	return results;
}

async function run() {
	console.log("Launching WebKit (Safari engine) ...\n");
	const browser = await webkit.launch({ headless: false });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 900 },
	});
	const page = await context.newPage();

	console.log(`Navigating to ${BASE_URL}/bench …\n`);
	await page.goto(`${BASE_URL}/bench`, { waitUntil: "networkidle" });
	await page.waitForSelector('[data-bench-id="pages"]', { timeout: 15000 });
	await page.waitForTimeout(3000);

	const allRows = [];

	for (const mode of ["light"]) {
		await page.evaluate((on) => window.__bench.setDarkMode(on), mode === "dark");
		await page.waitForTimeout(300);

		for (let pi = 0; pi < PDF_COUNT; pi++) {
			await page.evaluate((i) => window.__bench.selectPdf(i), pi);
			await page.waitForTimeout(3500);

			const pdfName = await page.evaluate(
				(i) => (window.__bench.pdfFiles ?? [])[i]?.name ?? `pdf-${i}`,
				pi,
			);
			const tag = `${pdfName}:${mode}:webkit`;

			console.log(`--- ${tag} ---`);

			const gs = await gentleScroll(page);
			if (gs) {
				allRows.push({ pdf: tag, test: "gentle-scroll", ...gs.frames });
				console.log(
					`  gentle-scroll   p50:${fmtMs(gs.frames.p50)} p95:${fmtMs(gs.frames.p95)} p99:${fmtMs(gs.frames.p99)}  dropped:${fmtN(gs.frames.droppedFrames)}/${gs.frames.totalFrames}  slow:${fmtN(gs.frames.slowFrames)}`,
				);
			}

			await page.waitForTimeout(500);

			const ff = await fastFlick(page);
			if (ff) {
				allRows.push({ pdf: tag, test: "fast-flick", ...ff.frames });
				console.log(
					`  fast-flick      p50:${fmtMs(ff.frames.p50)} p95:${fmtMs(ff.frames.p95)} p99:${fmtMs(ff.frames.p99)}  dropped:${fmtN(ff.frames.droppedFrames)}/${ff.frames.totalFrames}  slow:${fmtN(ff.frames.slowFrames)}`,
				);
			}

			await page.waitForTimeout(500);

			const ss = await scrollStopSelect(page);
			if (ss) {
				allRows.push({ pdf: tag, test: "scroll-stop", ttts: ss.ttts });
				console.log(
					`  scroll-stop     ttts: ${ss.ttts >= 0 ? ss.ttts + "ms" : "TIMEOUT"}  textLayers: ${ss.textLayers.count} (${ss.textLayers.totalSpans} spans)`,
				);
			}

			await page.waitForTimeout(500);

			const flash = await flashDetection(page);
			const blankPages = Array.isArray(flash)
				? flash.filter((s) => s.blank > 0)
				: [];
			allRows.push({
				pdf: tag,
				test: "flash-detect",
				blankSnapshots: blankPages.length,
				snapshots: flash,
			});
			console.log(
				`  flash-detect    ${blankPages.length === 0 ? "PASS — no blank canvases" : `FAIL — ${blankPages.length} snapshots with blank canvases`}`,
			);

			const domAfter = await getDomStats(page);
			console.log(
				`  dom             total:${fmtN(domAfter.totalElements)}  textLayers:${fmtN(domAfter.textLayers)}  maxChildren:${fmtN(domAfter.maxTextLayerChildren)}  spans:${fmtN(domAfter.totalSpans)}`,
			);

			allRows.push({ pdf: tag, test: "dom-stats", ...domAfter });
			console.log();
		}
	}

	console.log("=== FULL RESULTS (JSON) ===");
	console.log(JSON.stringify(allRows, null, 2));

	await browser.close();
	console.log("\nDone (WebKit/Safari).");
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
