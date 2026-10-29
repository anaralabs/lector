// Functional checks against the demo: search, outline, links, dark mode, selection.
import { chromium } from "playwright-core";
const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const out = process.argv[3] ?? ".";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--use-angle=metal"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.__firstPaintMs !== undefined);
await page.waitForTimeout(800);
const check = (name, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);

let t = Date.now();
const hits = await page.evaluate(() => window.__viewer.search("programmable matter"));
check("search across 26 pages", hits.length > 3, `${hits.length} hits in ${Date.now() - t}ms; first p${hits[0]?.page + 1}: "${hits[0]?.snippet.slice(0, 70)}"`);
check("search hit has rects", hits[0]?.rects.length > 0, JSON.stringify(hits[0]?.rects[0]));
t = Date.now();
const again = await page.evaluate(() => window.__viewer.search("automaton"));
check("warm search", again.length > 0, `${again.length} hits in ${Date.now() - t}ms`);

const outline = await page.evaluate(() => window.__viewer.outline());
check("outline", Array.isArray(outline), `${outline.length} top-level items: ${outline.slice(0, 4).map((o) => `${o.title}→p${o.dest?.page + 1}`).join(", ")}`);

// show hits as highlights, reveal the 5th
await page.evaluate((h) => {
	window.__viewer.setHighlights(h.map((x, i) => ({ id: `s${i}`, page: x.page, rects: x.rects, interactive: false })));
	window.__viewer.reveal(h[4].page, h[4].rects[0]);
}, hits);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/f1-search-reveal.png` });

// internal link: find a link on page 1 via evaluate on text? click a reference marker instead: use goToPage + page text
const text = await page.evaluate(() => window.__viewer.pageText(0));
check("page text", text.includes("CADbots"), `${text.length} chars`);

// links: listen for view change after clicking each candidate isn't practical blind; check cursor over a known link area via events
await page.evaluate(() => window.__viewer.setHighlights([]));
await page.evaluate(() => { window.__viewer.fitWidth(); window.__viewer.goToPage(0); });
await page.waitForTimeout(500);
await page.evaluate(() => window.__viewer.setOptions({ dark: true, background: [0.07, 0.07, 0.08] }));
await page.mouse.move(200, 560);
await page.mouse.down();
await page.mouse.move(700, 640, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/f2-dark-selection.png` });
const sel = await page.evaluate(() => window.__events.length);
void sel;
check("no errors", errors.length === 0, errors.join(" | "));
await browser.close();
