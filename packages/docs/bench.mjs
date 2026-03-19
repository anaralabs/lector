import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE_URL = process.env.BENCH_URL || "http://localhost:3001";
const PDF_COUNT = 5;
const SAVE_TRACES = process.argv.includes("--trace");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metricMap(raw) {
  const m = {};
  for (const { name, value } of raw.metrics) m[name] = value;
  return m;
}

function diffMetrics(before, after) {
  const b = metricMap(before);
  const a = metricMap(after);
  return {
    layoutCount: (a.LayoutCount ?? 0) - (b.LayoutCount ?? 0),
    layoutDurationMs: Math.round(((a.LayoutDuration ?? 0) - (b.LayoutDuration ?? 0)) * 1000 * 100) / 100,
    recalcStyleCount: (a.RecalcStyleCount ?? 0) - (b.RecalcStyleCount ?? 0),
    recalcStyleDurationMs: Math.round(((a.RecalcStyleDuration ?? 0) - (b.RecalcStyleDuration ?? 0)) * 1000 * 100) / 100,
    scriptDurationMs: Math.round(((a.ScriptDuration ?? 0) - (b.ScriptDuration ?? 0)) * 1000 * 100) / 100,
    taskDurationMs: Math.round(((a.TaskDuration ?? 0) - (b.TaskDuration ?? 0)) * 1000 * 100) / 100,
    jsHeapMB: Math.round(((a.JSHeapUsedSize ?? 0) / 1024 / 1024) * 10) / 10,
  };
}

function fmtMs(n) { return String(Math.round(n * 100) / 100).padStart(8) + "ms"; }
function fmtN(n)  { return String(n).padStart(6); }

async function startTrace(cdp) {
  if (!SAVE_TRACES) return;
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline",
    options: "sampling-frequency=10000",
  });
}

async function stopTrace(cdp, name) {
  if (!SAVE_TRACES) return;
  const chunks = [];
  cdp.on("Tracing.dataCollected", (p) => chunks.push(...p.value));
  await cdp.send("Tracing.end");
  await new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  const file = `trace-${name.replace(/[^a-z0-9]/gi, "-")}.json`;
  writeFileSync(file, JSON.stringify(chunks));
  console.log(`    trace saved → ${file}`);
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
    return { totalElements: all, textLayers: tls.length, maxTextLayerChildren: maxChildren, totalSpans };
  });
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

async function gentleScroll(page, cdp) {
  const info = await page.evaluate(() => window.__bench.getScrollInfo());
  if (!info) return null;

  const viewportH = info.clientHeight;
  const totalDistance = Math.min(info.maxScroll, viewportH * 5);
  const steps = 100;
  const delta = totalDistance / steps;

  await page.evaluate(() => window.__bench.scrollTo(0));
  await page.waitForTimeout(200);

  await page.evaluate(() => window.__bench.startFrameRecording());
  const before = await cdp.send("Performance.getMetrics");

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  const after = await cdp.send("Performance.getMetrics");
  const frames = await page.evaluate(() => window.__bench.stopFrameRecording());

  return { frames, cdp: diffMetrics(before, after) };
}

async function fastFlick(page, cdp) {
  const info = await page.evaluate(() => window.__bench.getScrollInfo());
  if (!info) return null;

  const viewportH = info.clientHeight;
  const totalDistance = Math.min(info.maxScroll, viewportH * 20);
  const steps = 40;
  const delta = totalDistance / steps;

  await page.evaluate(() => window.__bench.scrollTo(0));
  await page.waitForTimeout(200);

  await page.evaluate(() => window.__bench.startFrameRecording());
  const before = await cdp.send("Performance.getMetrics");

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(500);

  const after = await cdp.send("Performance.getMetrics");
  const frames = await page.evaluate(() => window.__bench.stopFrameRecording());

  return { frames, cdp: diffMetrics(before, after) };
}

async function scrollStopSelect(page, cdp) {
  const info = await page.evaluate(() => window.__bench.getScrollInfo());
  if (!info) return null;

  const viewportH = info.clientHeight;
  const scrollDistance = viewportH * 3;
  const steps = 20;
  const delta = scrollDistance / steps;

  await page.evaluate(() => window.__bench.scrollTo(0));
  await page.waitForTimeout(300);

  const before = await cdp.send("Performance.getMetrics");

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(30);
  }

  const scrollDone = Date.now();

  // Wait for text layer spans to appear on currently visible pages
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

  const after = await cdp.send("Performance.getMetrics");
  const status = await page.evaluate(() => window.__bench.getTextLayerStatus());

  return { ttts, textLayers: status, cdp: diffMetrics(before, after) };
}

async function zoomCycle(page, cdp) {
  const el = await page.locator('[data-bench-id="pages"]');
  const box = await el.boundingBox();
  if (!box) return null;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.evaluate(() => window.__bench.startFrameRecording());
  const before = await cdp.send("Performance.getMetrics");

  // Zoom in via ctrl+wheel
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx, cy);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
  }

  await page.waitForTimeout(300);

  // Zoom out
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(cx, cy);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 100);
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
  }

  await page.waitForTimeout(300);

  // Zoom back in to original
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx, cy);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
  }

  await page.waitForTimeout(300);

  const after = await cdp.send("Performance.getMetrics");
  const frames = await page.evaluate(() => window.__bench.stopFrameRecording());

  return { frames, cdp: diffMetrics(before, after) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  console.log(`\nNavigating to ${BASE_URL}/bench …\n`);
  await page.goto(`${BASE_URL}/bench`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-bench-id="pages"]', { timeout: 15000 });
  await page.waitForTimeout(2000);

  const allRows = [];

  for (const mode of ["light", "dark"]) {
    await page.evaluate((on) => window.__bench.setDarkMode(on), mode === "dark");
    await page.waitForTimeout(300);

    for (let pi = 0; pi < PDF_COUNT; pi++) {
      await page.evaluate((i) => window.__bench.selectPdf(i), pi);
      await page.waitForTimeout(3500);

      const pdfName = await page.evaluate(
        (i) => (window.__bench.pdfFiles ?? [])[i]?.name ?? `pdf-${i}`,
        pi,
      );
      const tag = `${pdfName}:${mode}`;

      console.log(`--- ${tag} ---`);

      const domBefore = await getDomStats(page);

      // Gentle scroll
      const gs = await gentleScroll(page, cdp);
      if (gs) {
        const r = { pdf: tag, test: "gentle-scroll", ...gs.frames, ...gs.cdp };
        allRows.push(r);
        console.log(`  gentle-scroll   p50:${fmtMs(gs.frames.p50)} p95:${fmtMs(gs.frames.p95)} p99:${fmtMs(gs.frames.p99)}  dropped:${fmtN(gs.frames.droppedFrames)}/${gs.frames.totalFrames}  layouts:${fmtN(gs.cdp.layoutCount)} (${fmtMs(gs.cdp.layoutDurationMs)})  styles:${fmtN(gs.cdp.recalcStyleCount)} (${fmtMs(gs.cdp.recalcStyleDurationMs)})`);
      }

      await page.waitForTimeout(500);

      // Fast flick (with optional trace capture)
      await startTrace(cdp);
      const ff = await fastFlick(page, cdp);
      await stopTrace(cdp, `${tag}-fast-flick`);
      if (ff) {
        const r = { pdf: tag, test: "fast-flick", ...ff.frames, ...ff.cdp };
        allRows.push(r);
        console.log(`  fast-flick      p50:${fmtMs(ff.frames.p50)} p95:${fmtMs(ff.frames.p95)} p99:${fmtMs(ff.frames.p99)}  dropped:${fmtN(ff.frames.droppedFrames)}/${ff.frames.totalFrames}  layouts:${fmtN(ff.cdp.layoutCount)} (${fmtMs(ff.cdp.layoutDurationMs)})  styles:${fmtN(ff.cdp.recalcStyleCount)} (${fmtMs(ff.cdp.recalcStyleDurationMs)})`);
      }

      await page.waitForTimeout(500);

      // Scroll-stop-select
      const ss = await scrollStopSelect(page, cdp);
      if (ss) {
        allRows.push({ pdf: tag, test: "scroll-stop", ttts: ss.ttts, ...ss.cdp });
        console.log(`  scroll-stop     ttts: ${ss.ttts >= 0 ? ss.ttts + "ms" : "TIMEOUT"}  textLayers: ${ss.textLayers.count} (${ss.textLayers.totalSpans} spans)  layouts:${fmtN(ss.cdp.layoutCount)} (${fmtMs(ss.cdp.layoutDurationMs)})`);
      }

      await page.waitForTimeout(500);

      // Zoom cycle
      const zc = await zoomCycle(page, cdp);
      if (zc) {
        const r = { pdf: tag, test: "zoom-cycle", ...zc.frames, ...zc.cdp };
        allRows.push(r);
        console.log(`  zoom-cycle      p50:${fmtMs(zc.frames.p50)} p95:${fmtMs(zc.frames.p95)} p99:${fmtMs(zc.frames.p99)}  dropped:${fmtN(zc.frames.droppedFrames)}/${zc.frames.totalFrames}  layouts:${fmtN(zc.cdp.layoutCount)} (${fmtMs(zc.cdp.layoutDurationMs)})  styles:${fmtN(zc.cdp.recalcStyleCount)} (${fmtMs(zc.cdp.recalcStyleDurationMs)})`);
      }

      const domAfter = await getDomStats(page);
      console.log(`  dom             total:${fmtN(domAfter.totalElements)}  textLayers:${fmtN(domAfter.textLayers)}  maxChildren:${fmtN(domAfter.maxTextLayerChildren)}  spans:${fmtN(domAfter.totalSpans)}`);

      allRows.push({ pdf: tag, test: "dom-stats", ...domAfter });
      console.log();
    }
  }

  console.log("=== FULL RESULTS (JSON) ===");
  console.log(JSON.stringify(allRows, null, 2));

  await browser.close();
  console.log("\nDone.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
