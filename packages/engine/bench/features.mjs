// Functional checks against the demo: search, outline, links, dark mode, selection.
import { chromium } from "playwright-core";
const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const out = process.argv[3] ?? ".";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--use-angle=metal"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
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

// Search parity with lector: fuzzy + exact, folding, line/page breaks, progress, cancellation.
const sr = await page.evaluate(async () => {
	const v = window.__viewer;
	const progress = [];
	const res = await v.searchAsync("programable mater", { onProgress: (p) => progress.push(p.pagesSearched) });
	const p0 = await v.pageText(0);
	const p1 = await v.pageText(1);
	const cross = `${p0.trim().split(/\s+/).slice(-2).join(" ")} ${p1.trim().split(/\s+/).slice(0, 2).join(" ")}`;
	const crossHits = await v.search(cross);
	const ac = new AbortController();
	const pending = v.searchAsync("the", { signal: ac.signal }).then(() => "resolved", (e) => e.name);
	ac.abort();
	const aborted = await pending;
	return {
		fuzzy: res.fuzzyMatches.length,
		exact: res.exactMatches.length,
		score: res.fuzzyMatches[0]?.score,
		firstProgress: progress[0],
		pageCount: res.pageCount,
		line: (await v.search("programmable matter by presenting"))[0]?.rects.length,
		hyphen: (await v.search("manipulating a collective")).length,
		crossParts: crossHits[0]?.parts.map((p) => p.page).join(","),
		accents: [(await v.search("sandor")).length, (await v.search("sandor", 10, { matchDiacritics: false })).length],
		aborted,
		searching: v.isSearching,
	};
});
check("fuzzy search", sr.fuzzy > 3 && sr.exact === 0 && sr.score < 1, `${sr.fuzzy} fuzzy, best score ${sr.score?.toFixed(2)}`);
check("search streams progress", sr.firstProgress < sr.pageCount, `first progress after ${sr.firstProgress}/${sr.pageCount} pages`);
check("match across a line break", sr.line === 2 && sr.hyphen > 0, `${sr.line} rects; hyphenated: ${sr.hyphen}`);
check("match across a page break", sr.crossParts === "0,1", `parts on pages ${sr.crossParts}`);
check("diacritic folding (opt-in, like lector)", sr.accents[0] === 0 && sr.accents[1] > 0, `"sandor": ${sr.accents[0]} default, ${sr.accents[1]} folded`);
check("search cancellation", sr.aborted === "AbortError" && !sr.searching, sr.aborted);

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
// Hidden DOM text layer: visible pages ±1, labelled regions, native find, Cmd/Ctrl+A.
const regions = await page.evaluate(() => [...document.querySelectorAll('.lector-text-layer[role="document"] section[role="region"]')].map((s) => s.getAttribute("aria-label")));
check("text layer regions", regions.length >= 1 && regions.length <= 4 && regions[0] === "Page 1", regions.join(", "));
check("native find sees the text layer", await page.evaluate(() => window.find("toolbox")));
const layerStyle = await page.evaluate(() => {
	const s = getComputedStyle(document.querySelector(".lector-text-layer"));
	return `${s.pointerEvents} ${s.userSelect} ${s.color}`;
});
check("text layer is inert", layerStyle === "none none rgba(0, 0, 0, 0)", layerStyle);
await page.evaluate(() => getSelection().removeAllRanges());
await page.locator("#viewer").focus();
await page.keyboard.press("ControlOrMeta+a");
await page.waitForTimeout(300);
const pageAll = await page.evaluate(() => window.__viewer.selectedText.length);
await page.keyboard.press("ControlOrMeta+a");
await page.waitForTimeout(1000);
const docAll = await page.evaluate(() => window.__viewer.selectedText.length);
check("Cmd/Ctrl+A: page, then document", pageAll > 1000 && docAll > pageAll * 10, `${pageAll} then ${docAll} chars`);
await page.evaluate(() => window.__viewer.clearSelection());

// Selection: copy options (lector's copyOptions) and restoring a saved range on unloaded pages.
const copy = await page.evaluate(async () => {
	const v = window.__viewer;
	const m = await v.pageTextMap(0);
	const at = m.text.indexOf("programmable matter by");
	const from = m.chars[at];
	const to = m.chars[at + "programmable matter by".length];
	const sel = () => new Promise((r) => {
		const t = setInterval(() => {
			const e = window.__all.findLast((x) => x.type === "selection" && x.final && x.selection);
			if (e && e !== window.__lastSel) {
				window.__lastSel = e;
				clearInterval(t);
				r(e.selection);
			}
		}, 20);
	});
	const clip = () => {
		const ev = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
		document.dispatchEvent(ev);
		return ev.clipboardData.getData("text/plain");
	};
	document.getElementById("viewer").focus();
	window.__lastSel = window.__all.findLast((x) => x.type === "selection");
	v.select(0, from, to);
	const preserve = (await sel()).text;
	const copied = clip();
	v.setOptions({ copyOptions: { lineBreaks: "space", ignoreHyphenation: true } });
	const joined = (await sel()).text;
	v.setOptions({ copyOptions: {} });
	await sel();
	// Restore a two-page range whose text has never been loaded.
	v.setSelection({ start: { page: 20, index: 5 }, end: { page: 21, index: 40 } });
	const restored = await sel();
	v.clearSelection();
	return { preserve, copied, joined, restored: { pages: restored.pages.map((p) => `${p.page}:${p.rects.length}`), len: restored.text.length, range: restored.range } };
});
check("copy keeps hyphen + line break (lector default)", copy.preserve === "program-\nmable matter by" && copy.copied === copy.preserve, JSON.stringify(copy.preserve));
check("copyOptions: spaces, ignore hyphenation", copy.joined === "programmable matter by", JSON.stringify(copy.joined));
check("restore selection on unloaded pages", copy.restored.pages.length === 2 && copy.restored.len > 40 && copy.restored.range.start.page === 20, `${copy.restored.pages.join(" ")} ${copy.restored.len} chars`);

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

// Password-protected documents: a typed error, then unlock().
if (!(await has("password.pdf"))) skip("password", "password.pdf");
else {
	await page.goto(fixture("password.pdf"));
	await page.waitForFunction(() => window.__errors.length > 0 && window.__viewer);
	const first = await page.evaluate(() => window.__errors[0]);
	check("password error", first.code === "password" && first.phase === "document-load", `${first.code}/${first.phase}: ${first.message}`);
	const wrong = await page.evaluate(() => window.__viewer.unlock("nope"));
	const right = await page.evaluate(() => window.__viewer.unlock("secret"));
	const unlocked = await page.evaluate(() => window.__viewer.pageText(1));
	check("unlock", wrong === false && right === true && unlocked.includes("Unlocked page 2"), `wrong→${wrong}, right→${right}, p2 "${unlocked.trim()}"`);
	await page.goto(fixture("password.pdf", "&password=secret"));
	await page.waitForFunction(() => window.__firstPaintMs !== undefined);
	check("password option", (await page.evaluate(() => window.__errors.length)) === 0);
}

// HTTP range loading: same document through range requests, getData fetches the whole file.
await page.goto(fixture("cadbots.pdf", "&range=1&autoFetch=0"));
await page.waitForFunction(() => window.__paintedMs !== undefined);
const ranged = await page.evaluate(async () => ({ hits: (await window.__viewer.search("programmable matter")).length, bytes: (await window.__viewer.getData()).length }));
check("range loading", ranged.hits === 11 && ranged.bytes > 1e6, `${ranged.hits} hits, getData ${ranged.bytes} bytes`);

// interceptFind: Cmd/Ctrl+F becomes a `find` event while the viewer has focus.
await page.goto(fixture("cadbots.pdf", "&interceptFind=1"));
await page.waitForFunction(() => window.__firstPaintMs !== undefined);
await page.locator("#viewer").focus();
await page.keyboard.press("ControlOrMeta+f");
await page.waitForTimeout(100);
check("interceptFind emits find", await page.evaluate(() => window.__all.some((e) => e.type === "find")));

check("no errors", errors.length === 0, errors.join(" | "));
await browser.close();
