// Form filling against the demo: text, checkbox, radio, dropdown and list box
// edits re-render the page, selection still works off the fields, a tap on a
// phone focuses a native input, and saveDocument returns the filled bytes.
// Needs demo/public/form.pdf (node bench/fixtures/make-form.mjs).
// Usage: node bench/forms.mjs [demo url] [screenshot dir]
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const out = process.argv[3] ?? ".";
const base = new URL(url);
const fixture = (extra = "") => `${base.origin}${base.pathname}?file=/form.pdf${extra}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--use-angle=metal"] });
let failed = 0;
const check = (name, ok, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function open(context, extra = "") {
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e.stack || e)));
	page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text()));
	await page.goto(fixture(extra));
	await page.waitForFunction(() => window.__paintedMs !== undefined && window.__all.some((e) => e.type === "form-widgets" && e.page === 0));
	await page.waitForTimeout(300);
	return { page, errors };
}

/** Viewport point (css px) of a page point, from the demo's last layout and the viewer camera. */
const screen = (page, p, x, y) =>
	page.evaluate(
		({ p, x, y }) => {
			const v = window.__viewer;
			const layout = [...window.__all].reverse().find((e) => e.type === "ready" || e.type === "layout").layout;
			const r = v.canvas.getBoundingClientRect();
			const c = v.camera;
			return [r.left + (layout[p].x + x - c.x) * c.zoom, r.top + (layout[p].y + y - c.y) * c.zoom];
		},
		{ p, x, y },
	);
/** Centre of the named field's widget (`n`th widget of that field on the page). */
async function field(page, name, n = 0, pageIndex = 0) {
	const w = await page.evaluate(
		({ name, n, pageIndex }) => [...window.__all].reverse().find((e) => e.type === "form-widgets" && e.page === pageIndex).widgets.filter((w) => w.name === name)[n],
		{ name, n, pageIndex },
	);
	const [x, y] = await screen(page, pageIndex, (w.rect[0] + w.rect[2]) / 2, (w.rect[1] + w.rect[3]) / 2);
	const [l, t] = await screen(page, pageIndex, w.rect[0], w.rect[1]);
	const [r, b] = await screen(page, pageIndex, w.rect[2], w.rect[3]);
	return { x, y, box: [l, t, r, b], widget: w };
}
const changed = (page, name) =>
	page
		.waitForFunction((name) => [...window.__all].reverse().find((e) => e.type === "form-change" && e.name === name), name, { timeout: 5000 })
		.then((h) => h.jsonValue())
		.catch(() => null);
const painted = (page) => page.waitForFunction(() => !document.querySelector(".lector-form-field[readonly]"), null, { timeout: 5000 }).then(() => page.waitForTimeout(150));

/** Dark pixels inside a viewport box (screenshot of the viewer only). */
async function ink(page, [l, t, r, b]) {
	const png = await page.screenshot({ clip: { x: l + 2, y: t + 2, width: r - l - 4, height: b - t - 4 } });
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.width;
		c.height = img.height;
		const ctx = c.getContext("2d");
		ctx.drawImage(img, 0, 0);
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 300) n++;
		return n;
	}, png.toString("base64"));
}

// ---------------------------------------------------------------- desktop (mouse)
for (const offscreen of ["1", "0"]) {
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
	const { page, errors } = await open(ctx, offscreen === "0" ? "&offscreen=0" : "");
	const tag = offscreen === "0" ? " (main-thread compositor)" : "";

	const name = await field(page, "name");
	const before = await ink(page, name.box);
	await page.mouse.click(name.x, name.y);
	const focused = await page.evaluate(() => document.activeElement?.classList.contains("lector-form-field"));
	await page.keyboard.type("Ada Lovelace");
	if (!tag) await page.screenshot({ path: `${out}/form-typing.png` });
	await page.keyboard.press("Enter");
	const nameChange = await changed(page, "name");
	await painted(page);
	const after = await ink(page, name.box);
	check(`click a text field, type, Enter${tag}`, focused && nameChange?.value === "Ada Lovelace" && after > before + 50, `focused=${focused} change=${JSON.stringify(nameChange)} ink ${before}→${after}`);

	const agree = await field(page, "agree");
	const agreeBefore = await ink(page, agree.box);
	await page.mouse.click(agree.x, agree.y);
	const agreeChange = await changed(page, "agree");
	await page.waitForTimeout(250);
	const agreeAfter = await ink(page, agree.box);
	check(`checkbox toggles${tag}`, agreeChange?.value === "Yes" && agreeAfter > agreeBefore, `change=${JSON.stringify(agreeChange)} ink ${agreeBefore}→${agreeAfter}`);

	const large = await field(page, "size", 1);
	await page.mouse.click(large.x, large.y);
	const sizeChange = await changed(page, "size");
	check(`radio selects${tag}`, sizeChange?.value === "large", JSON.stringify(sizeChange));

	const color = await field(page, "color");
	await page.mouse.click(color.x, color.y);
	const select = await page.$("select.lector-form-field");
	if (select) await select.selectOption("Blue");
	const colorChange = await changed(page, "color");
	check(`dropdown picks from a native select${tag}`, !!select && colorChange?.value === "Blue", JSON.stringify(colorChange));

	const fruit = await field(page, "fruit");
	const [fl, ft, , fb] = fruit.box;
	await page.mouse.click(fl + 30, ft + (fb - ft) / 2);
	const fruitChange = await changed(page, "fruit");
	check(`list box selects${tag}`, fruitChange?.value === "Banana", JSON.stringify(fruitChange));

	await page.waitForTimeout(300);
	if (!tag) await page.screenshot({ path: `${out}/form-filled.png` });

	// Selection off the fields still works.
	const [sx, sy] = await screen(page, 0, 74, 98);
	const [ex, ey] = await screen(page, 0, 240, 98);
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	await page.mouse.move(ex, ey, { steps: 6 });
	await page.mouse.up();
	const selected = await page.evaluate(() => window.__viewer.selectedText);
	check(`text selection off the fields${tag}`, /Selectable/.test(selected), JSON.stringify(selected));

	// Escape drops an edit.
	await page.mouse.click(name.x, name.y);
	await page.keyboard.press("End");
	await page.keyboard.type(" (draft)");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(200);
	const kept = await page.evaluate(() => [...window.__all].filter((e) => e.type === "form-change" && e.name === "name").map((e) => e.value));
	check(`Escape cancels an edit${tag}`, kept.length === 1 && !(await page.$(".lector-form-field")), JSON.stringify(kept));

	// The same field on page 2 shows the value.
	await page.evaluate(() => window.__viewer.goToPage(1));
	await page.waitForFunction(() => window.__all.some((e) => e.type === "form-widgets" && e.page === 1));
	await page.waitForTimeout(500);
	const name2 = await field(page, "name", 0, 1);
	const page2Ink = await ink(page, name2.box);
	check(`a field repeated on another page shows the value${tag}`, name2.widget.value === "Ada Lovelace" && page2Ink > 50, `value=${JSON.stringify(name2.widget.value)} ink=${page2Ink}`);

	const saved = await page.evaluate(async () => {
		const bytes = await window.__viewer.saveDocument();
		const text = new TextDecoder("latin1").decode(bytes);
		return { pdf: text.startsWith("%PDF-"), name: text.includes("Ada Lovelace"), length: bytes.length };
	});
	check(`saveDocument returns the filled bytes${tag}`, saved.pdf && saved.name, JSON.stringify(saved));
	check(`no errors${tag}`, errors.length === 0, errors.slice(0, 3).join(" | "));
	await ctx.close();
}

// ---------------------------------------------------------------- phone (touch)
{
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
	const { page, errors } = await open(ctx);
	const name = await field(page, "name");
	await page.touchscreen.tap(name.x, name.y);
	await page.waitForTimeout(100);
	const input = await page.evaluate(() => {
		const el = document.activeElement;
		return el?.classList.contains("lector-form-field") ? { tag: el.tagName, font: getComputedStyle(el).fontSize } : null;
	});
	check("tap focuses a native input (soft keyboard) at >=16px (no iOS zoom)", input?.tag === "INPUT" && Number.parseFloat(input.font) >= 16, JSON.stringify(input));
	await page.keyboard.type("Grace");
	await page.screenshot({ path: `${out}/form-phone-typing.png` });
	const agree = await field(page, "agree");
	await page.touchscreen.tap(agree.x, agree.y);
	const nameChange = await changed(page, "name");
	const agreeChange = await changed(page, "agree");
	check("tapping another field commits the text and toggles the checkbox", nameChange?.value === "Grace" && agreeChange?.value === "Yes", `${JSON.stringify(nameChange)} ${JSON.stringify(agreeChange)}`);
	// A swipe that starts on a field scrolls instead of filling it.
	const y0 = await page.evaluate(() => window.__viewer.camera.y);
	const notes = await field(page, "notes");
	const cdp = await ctx.newCDPSession(page);
	const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: notes.x, y }] });
	await touch("touchStart", notes.y);
	for (let i = 1; i <= 8; i++) await touch("touchMove", notes.y - i * 25);
	await touch("touchEnd");
	await page.waitForTimeout(300);
	const y1 = await page.evaluate(() => window.__viewer.camera.y);
	const opened = await page.$("textarea.lector-form-field:not([readonly])");
	check("a swipe from a field pans the page", y1 > y0 + 20 && !opened, `camera y ${y0.toFixed(1)}→${y1.toFixed(1)}, editor ${opened ? "opened" : "closed"}`);
	await painted(page);
	await page.screenshot({ path: `${out}/form-phone-filled.png` });
	check("no errors (touch)", errors.length === 0, errors.slice(0, 3).join(" | "));
	await ctx.close();
}

await browser.close();
process.exit(failed ? 1 : 0);
