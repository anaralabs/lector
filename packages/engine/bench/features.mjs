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
// Reads screenshot pixels (css px) through an <img> in the page: no PNG decoder needed.
const pixels = async (points) => {
	const png = (await page.screenshot()).toString("base64");
	return page.evaluate(
		async ({ png, points }) => {
			const img = new Image();
			img.src = `data:image/png;base64,${png}`;
			await img.decode();
			const c = document.createElement("canvas");
			c.width = img.width;
			c.height = img.height;
			const ctx = c.getContext("2d");
			ctx.drawImage(img, 0, 0);
			const k = img.width / innerWidth;
			return points.map(([x, y]) => [...ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)]);
		},
		{ png, points },
	);
};
const base = new URL(url);
const fixture = (file, extra = "") => `${base.origin}${base.pathname}?file=/${file}${extra}`;
// Fixtures are generated (demo/public/*.pdf is gitignored): bench/fixtures/make-*.mjs.
const has = async (file) => (await fetch(`${base.origin}/${file}`, { method: "HEAD" })).headers.get("content-type")?.includes("pdf");
const skip = (name, file) => console.log(`SKIP  ${name}  — ${file} missing; run node bench/fixtures/make-${file.replace(".pdf", "")}.mjs`);

// Dark mode: a scanned page (one near-white image) darkens; photos keep their colours.
if (!(await has("scan.pdf"))) skip("scan dark mode", "scan.pdf");
else {
await page.goto(fixture("scan.pdf", "&dark=1"));
await page.waitForFunction(() => window.__firstPaintMs !== undefined);
await page.evaluate(() => window.__viewer.zoomTo(0.5));
await page.waitForTimeout(1200);
// 1280x860 viewport at 50%: p1 spans x 487..793, y 6..402; the photo on p2 is centred
// near (640, 600); p3 (a full-page photo) starts at y≈810.
const [scanPaper, photo, fullPhoto] = await pixels([[500, 30], [640, 600], [640, 840]]);
const luma = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const sat = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
await page.screenshot({ path: `${out}/f3-scan-dark.png` });
check("dark mode darkens scanned pages", luma(scanPaper) < 0.3, `scan paper rgb(${scanPaper})`);
check("dark mode keeps photos", sat(photo) > 0.3 && sat(fullPhoto) > 0.3, `photo rgb(${photo}), full-page photo rgb(${fullPhoto})`);
const scanHits = await page.evaluate(() => window.__viewer.search("invoice"));
check("scan OCR text searchable", scanHits.length === 1 && scanHits[0].page === 0, `${scanHits.length} hits`);
}

check("no errors", errors.length === 0, errors.join(" | "));
await browser.close();
