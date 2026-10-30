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

// Position: initial page, scroll state round trip, fit-page, goto offset, overlay, options.
await page.goto(fixture("cadbots.pdf", "&page=10"));
await page.waitForFunction(() => window.__paintedMs !== undefined);
const firstView = await page.evaluate(() => window.__all.find((e) => e.type === "view"));
check("initialPage before first paint", firstView?.page === 10, `first view: page ${firstView?.page}`);
const pos = await page.evaluate(async () => {
	const v = window.__viewer;
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	v.scrollToFraction(0.5);
	await wait(300);
	const state = v.scrollState();
	v.fitPage();
	await wait(300);
	const fitView = window.__all.findLast((e) => e.type === "view");
	v.fitWidth();
	await wait(200);
	await v.goToPage(3, 0, { offset: 100 });
	await wait(100);
	const cam = v.camera;
	const layout = window.__all.find((e) => e.type === "ready").layout;
	const input = document.createElement("input");
	input.style.pointerEvents = "auto";
	v.overlayElement.appendChild(input);
	input.focus();
	const before = v.camera.y;
	input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
	await wait(200);
	const after = v.camera.y;
	input.remove();
	v.setOptions({ selectionColorDark: [0.5, 0.1, 0.1, 1] });
	return {
		state,
		fit: fitView.fit,
		fitWidthFlag: fitView.fitWidth,
		gotoY: cam.y,
		expectY: layout[3].y - 100 / cam.zoom,
		overlay: getComputedStyle(v.overlayElement).pointerEvents,
		inputKeys: after === before,
		gap: v.options.pageGap,
		dark: v.options.selectionColorDark.join(","),
	};
});
check("scrollState / scrollToFraction", Math.abs(pos.state.fraction - 0.5) < 0.01 && pos.state.height > pos.state.viewportHeight, JSON.stringify(pos.state));
check("fit-page", pos.fit === "page" && pos.fitWidthFlag === false, `fit ${pos.fit}`);
check("goToPage offset", Math.abs(pos.gotoY - pos.expectY) < 0.5, `y ${pos.gotoY.toFixed(1)} vs ${pos.expectY.toFixed(1)}`);
check("overlay element + keys in host inputs", pos.overlay === "none" && pos.inputKeys, `pointer-events ${pos.overlay}`);
check("resolved options", pos.gap === 12 && pos.dark === "0.5,0.1,0.1,1", `pageGap ${pos.gap}, selectionColorDark ${pos.dark}`);
// Restore the saved scroll position on a fresh viewer.
await page.goto(fixture("cadbots.pdf", `&offset=${pos.state.top}`));
await page.waitForFunction(() => window.__paintedMs !== undefined);
const restored = await page.evaluate(() => window.__viewer.scrollState());
check("initialOffset restores scroll", Math.abs(restored.top - pos.state.top) < 1, `${restored.top.toFixed(0)} vs ${pos.state.top.toFixed(0)}`);
const fz = await page.evaluate(async () => {
	const hits = await window.__viewer.search("programmable matter", 30, { fuzzy: { threshold: 0.8 } });
	const exact = hits.filter((h) => h.exact);
	return {
		exact: exact.length,
		fuzzy: hits.length - exact.length,
		marked: exact.every((h) => h.snippet.slice(...h.snippetMatch).replace(/\s+/g, " ").toLowerCase() === "programmable matter"),
	};
});
check("search fuzzy option + snippetMatch", fz.exact > 3 && fz.fuzzy > 0 && fz.marked, JSON.stringify(fz));

// Forms: filled fields without appearance streams render through FPDF_FFLDraw.
if (!(await has("form-noap.pdf"))) skip("forms without appearances", "form-noap.pdf");
else {
	await page.goto(fixture("form-noap.pdf"));
	await page.waitForFunction(() => window.__paintedMs !== undefined);
	await page.waitForTimeout(600);
	// 1280px viewport, fit-width caps at 2x: page x0 = 28, top = 24 (12pt gap at 2x).
	const at = (x, y) => [28 + x * 2, 24 + (792 - y) * 2];
	const grid = [];
	for (let x = 134; x < 300; x += 4) for (let y = 644; y < 660; y += 3) grid.push(at(x, y)); // "Ada Lovelace" field
	for (let x = 132; x < 147; x += 2) for (let y = 597; y < 612; y += 2) grid.push(at(x, y)); // checkbox
	const px = await pixels(grid);
	const dark = (p) => p[0] + p[1] + p[2] < 200;
	const textInk = px.slice(0, -64).filter(dark).length;
	const checkInk = px.slice(-64).filter(dark).length;
	check("form fields without appearances render", textInk > 10 && checkInk > 3, `${textInk} dark samples in the text field, ${checkInk} in the checkbox`);
}

// RTL: Hebrew runs (logical order, boxes moving left) group into one line; the
// right edge is the line start; the text layer marks them dir=rtl.
if (!(await has("rtl.pdf"))) skip("rtl", "rtl.pdf");
else {
	await page.goto(fixture("rtl.pdf", "&offscreen=0"));
	await page.waitForFunction(() => window.__firstPaintMs !== undefined);
	const rtl = await page.evaluate(async () => {
		await window.__viewer.pageText(0);
		const t = window.__core.texts.get(0);
		const l1 = t.lines[1];
		await new Promise((r) => setTimeout(r, 400));
		return {
			lines: t.lines.map((l) => l.dir ?? "ltr").join(","),
			right: t.hitTest(l1.r - 1, (l1.t + l1.b) / 2) === l1.start,
			left: t.hitTest(l1.l + 1, (l1.t + l1.b) / 2) === l1.end,
			layer: [...document.querySelectorAll(".lector-text-layer span[dir=rtl]")].length,
		};
	});
	check("RTL lines and carets", rtl.lines === "ltr,rtl,rtl" && rtl.right && rtl.left && rtl.layer === 2, JSON.stringify(rtl));
}
// A contents page linking to more pages than a worker's page cache holds: its
// links and images are read while the destinations' pages load (and evict).
if (!(await has("links.pdf"))) skip("links to many pages", "links.pdf");
else {
	await page.goto(fixture("links.pdf", "&offscreen=0&workers=1"));
	await page.waitForFunction(() => window.__firstPaintMs !== undefined);
	const links = await page.evaluate(async () => {
		await window.__viewer.pageText(0);
		const c = window.__core;
		return { targets: (c.links.get(0) ?? []).map((l) => l.url ?? l.dest?.page).join(","), images: (c.images.get(0) ?? []).length / 4 };
	});
	check("links to 14 pages + images on one page", links.targets === "1,2,3,4,5,6,7,8,9,10,11,12,13,14,https://example.com/" && links.images === 1, JSON.stringify(links));
}
// Vertical (CJK top-to-bottom) lines, from synthetic char boxes: two columns, right to left.
const vertical = await page.evaluate(async (src) => {
	const { PageText } = await import(`/@fs${src}/text.ts`);
	const codes = Uint32Array.from([..."縦書き文字列"].map((c) => c.codePointAt(0)));
	const boxes = new Float32Array(codes.length * 4);
	[..."縦書き文字列"].forEach((_, i) => {
		const col = i < 3 ? 0 : 1; // first column on the right
		const x = 300 - col * 30;
		const y = 100 + (i % 3) * 20;
		boxes.set([x, y, x + 18, y + 18], i * 4);
	});
	const t = new PageText(codes, boxes);
	return { lines: t.lines.map((l) => `${l.dir}:${l.start}-${l.end}`).join(" "), caret: t.hitTest(309, 125), rect: t.rects(0, 2)[0], layer: t.layerLines()[0].dir };
}, new URL("../src", import.meta.url).pathname);
check("vertical lines", vertical.lines === "ttb:0-3 ttb:3-6" && vertical.caret === 1 && vertical.rect.h === 38 && vertical.layer === "ttb", JSON.stringify(vertical));

// Document metadata (lector's onDocumentLoad) and load failures through viewer.loaded.
await page.goto(fixture("scan.pdf"));
await page.waitForFunction(() => window.__viewer);
const meta = await page.evaluate(async () => (await window.__viewer.loaded).info);
check("viewer.loaded + metadata", meta.pageCount === 3 && meta.title === "Scan fixture" && meta.pdfVersion >= 14 && meta.hasForm === false, JSON.stringify(meta));
const errorsBefore = errors.length;
await page.goto(fixture("not-a-pdf.pdf"));
await page.waitForFunction(() => window.__viewer);
const bad = await page.evaluate(() => window.__viewer.loaded.then(() => "resolved", (e) => `${e.name}:${e.code}/${e.phase}`));
check("parse error rejects loaded", bad === "EngineError:parse/document-load", bad);
errors.length = errorsBefore; // the HUD logs that load error to the console on purpose

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

// ---------------------------------------------------------------- lifecycle
const src = new URL("../src", import.meta.url).pathname;
const settle = (p, ms = 8000) => Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), ms))]);

// Construction is transactional; destroy and load failures settle every request.
await page.goto(fixture("cadbots.pdf", "&offscreen=0"));
await page.waitForFunction(() => window.__firstPaintMs !== undefined);
const life = await page.evaluate(async (src) => {
	const { createViewer } = await import(`/@fs${src}/index.ts`);
	const { default: wasmUrl, workerUrls } = await import(`/@fs${src}/vite-wasm.ts`);
	const timeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), 8000))]);
	const demoCore = window.__core; // test viewers below replace it (debug mode)
	const host = () => {
		const el = document.createElement("div");
		el.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px";
		document.body.appendChild(el);
		return el;
	};
	const loader = (url, name) => new Worker(URL.createObjectURL(new Blob([`import(${JSON.stringify(url.href)})`], { type: "text/javascript" })), { name });
	// A factory that throws on the second worker: the first one and the canvas go.
	const failing = host();
	const terminated = [];
	let made = 0;
	const createWorker = (url, name) => {
		if (++made === 2) throw new Error("factory failed");
		const w = loader(url, name);
		const t = w.terminate.bind(w);
		w.terminate = () => {
			terminated.push(name);
			t();
		};
		return w;
	};
	const partial = await createViewer(failing, "/cadbots.pdf", { wasmUrl, workerUrls, createWorker, workers: 3, offscreen: false }).then(() => "resolved", (e) => e.message);
	const partialLeft = { children: failing.children.length, tabindex: failing.getAttribute("tabindex"), overflow: failing.style.overflow };
	failing.remove();
	// Destroy with requests in flight (before the document opened).
	const early = host();
	const v = await createViewer(early, "/cadbots.pdf", { wasmUrl, workerUrls, createWorker: loader, offscreen: false });
	const code = (p) => p.then(() => "resolved", (e) => (e instanceof DOMException ? e.name : (e.code ?? e.name)));
	const inflight = [v.loaded, v.pageText(3), v.outline(), v.thumbnail(0, 120), v.rects(0, 0, 5)].map(code);
	v.destroy();
	const destroyed = await timeout(Promise.all(inflight));
	const after = await timeout(Promise.all([code(v.pageText(0)), v.goToPage(1), v.unlock("x")]).then((r) => r.join()));
	const earlyLeft = early.children.length;
	early.remove();
	// A document that cannot open: waiting requests reject with its error.
	const bad = host();
	const b = await createViewer(bad, "/not-a-pdf.pdf", { wasmUrl, workerUrls, createWorker: loader, offscreen: false });
	const failed = await timeout(code(b.pageText(0)));
	b.destroy();
	bad.remove();
	window.__core = demoCore;
	// cancelSearch removes the caller's abort listener and leaves no search running.
	const viewer = window.__viewer;
	const ac = new AbortController();
	let removed = 0;
	const remove = ac.signal.removeEventListener.bind(ac.signal);
	ac.signal.removeEventListener = (type, fn) => {
		if (type === "abort") removed++;
		remove(type, fn);
	};
	const search = code(viewer.searchAsync("the", { signal: ac.signal }));
	viewer.cancelSearch();
	const cancelled = await timeout(search);
	// Duplicate thumbnail requests share one job; both resolve.
	const thumbs = await timeout(Promise.all([viewer.thumbnail(2, 160), viewer.thumbnail(2, 160)]).then((t) => t.map((b) => b?.width)));
	return { partial, partialLeft, terminated, destroyed, after, earlyLeft, failed, cancelled, removed, searching: viewer.isSearching, thumbs };
}, src);
check("partial construction failure cleans up", life.partial === "factory failed" && life.partialLeft.children === 0 && life.partialLeft.tabindex === null && life.partialLeft.overflow === "" && life.terminated.join() === "lector-raster-0", JSON.stringify({ ...life.partialLeft, terminated: life.terminated }));
check("destroy settles pending requests", life.destroyed.join() === "destroyed,destroyed,destroyed,destroyed,destroyed" && life.after === "destroyed,false,false" && life.earlyLeft === 0, `${life.destroyed.join()}; after: ${life.after}`);
check("load failure settles pending requests", life.failed === "parse", life.failed);
check("cancelSearch cleans up", life.cancelled === "AbortError" && life.removed === 1 && !life.searching, `${life.cancelled}, abort listener removed ${life.removed}x`);
check("duplicate thumbnails both resolve", Array.isArray(life.thumbs) && life.thumbs.join() === "160,160", JSON.stringify(life.thumbs));

// Selection: a newer intent wins over a programmatic selection waiting for text;
// a collapsed range clears the old rects.
const selRace = await page.evaluate(async () => {
	const v = window.__viewer;
	const c = window.__core;
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	v.select(12, 0, 50); // text not loaded yet
	v.clearSelection();
	v.select(0, 0, 40); // text cached: still resumes asynchronously
	v.clearSelection();
	await wait(600);
	const cleared = { text: v.selectedText, rects: c.selRects.length };
	v.select(0, 0, 40);
	await wait(200);
	const before = c.selRects.length;
	v.select(0, 10, 10);
	await wait(200);
	return { cleared, before, collapsed: c.selRects.length, text: v.selectedText };
});
check("select then clearSelection stays cleared", selRace.cleared.text === "" && selRace.cleared.rects === 0, JSON.stringify(selRace.cleared));
check("collapsed selection clears rects", selRace.before > 0 && selRace.collapsed === 0 && selRace.text === "", JSON.stringify(selRace));

// Double/triple click: word, then line (pointer events report detail 0; the shell counts).
const word = await page.evaluate(async () => {
	const v = window.__viewer;
	await v.goToPage(0);
	const m = await v.pageTextMap(0);
	const at = m.text.indexOf("toolbox");
	const [r] = await v.rects(0, m.chars[at], m.chars[at + 7]);
	const layout = window.__all.find((e) => e.type === "ready").layout[0];
	const cam = v.camera;
	return { x: (layout.x + r.x + r.w / 2 - cam.x) * cam.zoom, y: (layout.y + r.y + r.h / 2 - cam.y) * cam.zoom };
});
await page.mouse.dblclick(word.x, word.y);
await page.waitForTimeout(200);
const dbl = await page.evaluate(() => window.__viewer.selectedText);
await page.mouse.click(word.x, word.y, { clickCount: 3 });
await page.waitForTimeout(200);
const triple = await page.evaluate(() => window.__viewer.selectedText);
check("double click selects a word, triple a line", dbl === "toolbox" && triple.includes("toolbox") && triple.length > 20 && !triple.trim().includes("\n"), `${JSON.stringify(dbl)} / ${JSON.stringify(triple)}`);
await page.evaluate(() => window.__viewer.clearSelection());

// Destroying during selection autoscroll stops every frame (main-thread compositor).
await page.mouse.move(word.x, word.y);
await page.mouse.down();
await page.mouse.move(word.x, 855, { steps: 4 });
const loop = await page.evaluate(async () => {
	const c = window.__core;
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const f0 = c.frameId;
	await wait(300);
	const scrolling = c.frameId - f0;
	window.__viewer.destroy();
	const f1 = c.frameId;
	await wait(400);
	return { scrolling, after: c.frameId - f1, global: "__core" in window };
});
await page.mouse.up();
check("destroy during autoscroll stops frames", loop.scrolling > 5 && loop.after === 0 && !loop.global, JSON.stringify(loop));

// Worker compositor: destroy disposes the core and every worker exits.
await page.goto(fixture("cadbots.pdf"));
await page.waitForFunction(() => window.__firstPaintMs !== undefined);
const workersBefore = page.workers().length;
await page.evaluate(() => window.__viewer.destroy());
await page.waitForTimeout(1500);
check("destroy ends the compositor worker", workersBefore >= 3 && page.workers().length === 0, `${workersBefore} workers, then ${page.workers().length}`);

// WebGL context loss: rendering stops, then resumes with re-uploaded tiles.
const coreWorker = async () => {
	for (const w of page.workers()) if (await w.evaluate(() => !!self.__core).catch(() => false)) return w;
	return null;
};
for (const mode of ["main thread", "worker"]) {
	await page.goto(fixture("cadbots.pdf", mode === "worker" ? "" : "&offscreen=0"));
	await page.waitForFunction(() => window.__paintedMs !== undefined);
	await page.waitForTimeout(800);
	const target = mode === "worker" ? await coreWorker() : page;
	const scope = mode === "worker" ? "self" : "window";
	const lose = new Function(`const c = ${scope}.__core; const ext = c.gl.gl.getExtension("WEBGL_lose_context"); ext.loseContext(); ${scope}.__ext = ext; return [...c.tiles.values()].filter((t) => t.tex).length;`);
	const before = await target.evaluate(lose);
	await page.waitForTimeout(300);
	await target.evaluate(new Function(`${scope}.__ext.restoreContext();`));
	await page.mouse.move(640, 430);
	await page.mouse.wheel(0, 40);
	await page.waitForTimeout(1200);
	const after = await target.evaluate(new Function(`const c = ${scope}.__core; return { lost: c.gl.lost, tiles: [...c.tiles.values()].filter((t) => t.tex).length };`));
	const [paper] = await pixels([[640, 300]]);
	const lostEvent = await page.evaluate(() => window.__errors.some((e) => e.code === "gpu" && e.phase === "render"));
	check(`context loss and restore (${mode})`, before > 0 && !after.lost && after.tiles > 0 && lostEvent && paper[0] > 200, `${before} tiles, then ${after.tiles}; page pixel rgb(${paper})`);
}
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes("WebGL context was lost")));

// Fit-page jumps fit the destination page (links.pdf's last page is twice as tall).
if (await has("links.pdf")) {
	await page.goto(fixture("links.pdf", "&zoom=fit-page"));
	await page.waitForFunction(() => window.__firstPaintMs !== undefined);
	const fit = await page.evaluate(async () => {
		const v = window.__viewer;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const before = v.camera.zoom;
		await v.goToPage(14);
		await wait(100); // the camera event follows on the next frame
		const tall = v.camera.zoom;
		const view = window.__all.findLast((e) => e.type === "view");
		await v.goToPage(1);
		await wait(100);
		return { before, tall, back: v.camera.zoom, fit: view.fit, viewH: v.scrollState().viewportHeight };
	});
	check("fit-page navigation refits the destination", fit.tall * 1600 <= fit.viewH && fit.tall < fit.before * 0.6 && Math.abs(fit.back - fit.before) < 1e-6 && fit.fit === "page", JSON.stringify(fit));
}

// Mixed-direction lines: hit-test glyph boxes in visual order. Logical "abאבcd" is
// drawn a b ב א c d (the Hebrew run reversed).
const bidi = await page.evaluate(async (src) => {
	const { PageText } = await import(`/@fs${src}/text.ts`);
	const logical = "abאבcd";
	const codes = Uint32Array.from([...logical].map((c) => c.codePointAt(0)));
	const visualX = [0, 10, 30, 20, 40, 50]; // left edge of each logical char
	const boxes = new Float32Array(codes.length * 4);
	visualX.forEach((x, i) => boxes.set([x, 100, x + 10, 112], i * 4));
	const t = new PageText(codes, boxes);
	return [57, 53, 38, 32, 22, 2].map((x) => t.hitTest(x, 106));
}, src);
check("mixed-direction hit testing", bidi.join() === "6,5,2,3,4,0", bidi.join());

check("no errors", errors.length === 0, errors.join(" | "));
await browser.close();
