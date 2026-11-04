// Smart selection in a browser: multi-click units, column-aware drags, page breaks, OCR scan.
// Usage: node bench/fixtures/make-paper.mjs && node bench/fixtures/make-scan-ocr.mjs && node bench/smart-select.mjs [url] ["&compositor=canvas2d"]
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const query = process.argv[3] ?? "";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
let failed = 0;
const check = (name, ok, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const open = async (file, extra = "") => {
	await page.goto(`${url}?file=/${file}&offscreen=0&zoom=fit-page${extra}${query}`);
	await page.waitForFunction(() => window.__firstPaintMs !== undefined && window.__core?.texts.has(0));
	await page.waitForTimeout(300);
};
/** viewport point at a needle's char (offset) on a page */
const point = (needle, pageIndex = 0, offset = 2) =>
	page.evaluate(
		async ([needle, pageIndex, offset]) => {
			const v = window.__viewer;
			const m = await v.pageTextMap(pageIndex);
			const i = m.text.replace(/\n/g, " ").indexOf(needle);
			if (i < 0) throw new Error(`"${needle}" not on page ${pageIndex}`);
			const [r] = await v.rects(pageIndex, m.chars[i + offset], m.chars[i + offset] + 1);
			const layout = window.__core.layout[pageIndex];
			const cam = v.camera;
			return { x: (layout.x + r.x + r.w / 2 - cam.x) * cam.zoom, y: (layout.y + r.y + r.h / 2 - cam.y) * cam.zoom };
		},
		[needle, pageIndex, offset],
	);
const selected = () => page.evaluate(() => window.__viewer.selectedText.replace(/\s+/g, " ").trim());
const clicks = async (needle, count, pageIndex = 0) => {
	const p = await point(needle, pageIndex);
	await page.mouse.click(p.x, p.y, { clickCount: count });
	await page.waitForTimeout(150);
	return selected();
};
const units = [];
const lastUnit = () =>
	page.evaluate(() => {
		const e = window.__all.findLast((e) => e.type === "selection" && e.final && e.selection);
		return e?.selection.unit ?? null;
	});
const reset = async () => {
	units.push(await lastUnit());
	await page.evaluate(() => window.__viewer.clearSelection());
	await page.waitForTimeout(600);
};

await open("paper.pdf");
const cost = await page.evaluate(() => {
	const t = window.__core.texts.get(0);
	const fresh = new t.constructor(t.codes, t.boxes, 792);
	const t0 = performance.now();
	fresh.layout().sentence(100);
	return performance.now() - t0;
});
check("page structure is cheap (built on the first multi-click)", cost < 40, `${cost.toFixed(1)}ms for page 1`);

check("double click: word", (await clicks("Smith et al.", 2)) === "Smith");
await reset();
const hyphenated = await clicks("ding and annotating", 2);
check("double click: hyphenated word (both halves)", hyphenated.replace(/-\s*/, "") === "reading", JSON.stringify(hyphenated));
await reset();
const sentence = await clicks("error rate", 3);
check("triple click: sentence through Fig. and i.e.", sentence === "As shown in Fig. 2, the error rate grows with the number of columns, i.e., two-column papers fare worst.", JSON.stringify(sentence));
await reset();
const para = await clicks("gap threshold", 4);
check("four clicks: paragraph", para.startsWith("Every page is first split") && para.endsWith("by a clear gap."), JSON.stringify(para.slice(0, 60)));
await reset();
const col = await clicks("Because segmentation", 3);
check("triple click stops at the column break", col.endsWith("and a page that is") && !col.includes("selected"), JSON.stringify(col));
await reset();

// Triple click, then drag: into the gutter (stays), then onto the other column (crosses).
{
	const a = await point("Because segmentation");
	const b = await point("selected repeatedly");
	await page.mouse.move(a.x, a.y);
	await page.mouse.down({ clickCount: 1 });
	await page.mouse.up({ clickCount: 1 });
	await page.mouse.down({ clickCount: 2 });
	await page.mouse.up({ clickCount: 2 });
	await page.mouse.down({ clickCount: 3 });
	const leftEdge = await point("selected repeatedly", 0, 0);
	await page.mouse.move(leftEdge.x - 6, a.y, { steps: 6 });
	await page.waitForTimeout(100);
	const inGutter = await page.evaluate(() => {
		const [s, e] = window.__core.selRange;
		return window.__core.texts.get(0).text(s.index, e.index).replace(/\s+/g, " ");
	});
	await page.mouse.move(b.x + 20, b.y + 4, { steps: 6 });
	await page.mouse.up({ clickCount: 3 });
	await page.waitForTimeout(150);
	const crossed = await selected();
	check("sentence drag stays in its column over the gutter", !inGutter.includes("selected") && !inGutter.includes("Results"), JSON.stringify(inGutter.slice(-40)));
	check("…and crosses once the pointer is on the other column", crossed.includes("selected repeatedly pays only once"), JSON.stringify(crossed.slice(-60)));
}
await reset();

// Double click near the bottom of page 1, drag onto page 2: headers/footers are not in the selection.
{
	await page.evaluate(() => window.__viewer.goToPage(0, 520, { animate: false }));
	await page.waitForTimeout(400);
	const a = await point("A third concerns");
	await page.mouse.move(a.x, a.y);
	await page.mouse.down({ clickCount: 1 });
	await page.mouse.up({ clickCount: 1 });
	await page.mouse.down({ clickCount: 2 });
	const target = await page.evaluate(() => {
		const c = window.__core;
		const r = c.layout[1];
		return { x: (r.x + 120 - c.cam.x) * c.cam.zoom, y: Math.min(990, (r.y + 80 - c.cam.y) * c.cam.zoom) };
	});
	await page.mouse.move(target.x, target.y, { steps: 10 });
	await page.mouse.up({ clickCount: 2 });
	await page.waitForTimeout(200);
	const text = await selected();
	check("word drag over a page break skips the running header and page number", text.startsWith("third") && text.includes("around them") && !/Journal of Fixture|Research article/.test(text), JSON.stringify(text.slice(0, 50) + " … " + text.slice(-50)));
}
await reset();

const over = await clicks("A third concerns equations", 3);
check("triple click: a sentence cut by the page break continues on the next page", over.startsWith("A third concerns equations") && over.endsWith("whole sentence."), JSON.stringify(over.slice(-60)));
await reset();
check("single click still selects nothing", (await clicks("error rate", 1)) === "");
check("selection events carry the unit", ["word", "sentence", "paragraph"].every((u) => units.includes(u)), units.join(","));

await open("scan-ocr.pdf");
check("scan: double click on the OCR layer", (await clicks("northern", 2)) === "northern");
await reset();
check("scan: triple click", (await clicks("old mill", 3)) === "Dr. Hale reported that the old mill, i.e. the building on the river, was in poor repair.");
await reset();
const scanPara = await clicks("Mr. Grant", 4);
check("scan: four clicks", scanPara.startsWith("Members asked") && scanPara.endsWith("of the accounts."), JSON.stringify(scanPara.slice(0, 40)));

check("no errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
