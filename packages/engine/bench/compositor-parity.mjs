// Same view through two renders (light and dark, highlights + selection), then a per-pixel diff.
// Default: WebGL2 vs Canvas 2D on URL. AGAINST=<url>: WebGL2 on URL vs WebGL2 on AGAINST (another build).
import { chromium } from "playwright-core";
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const url = process.env.URL ?? "http://127.0.0.1:5199/";
const sides = process.env.AGAINST ? [[url, "webgl2"], [process.env.AGAINST, "webgl2"]] : [[url, "webgl2"], [url, "canvas2d"]];
const browser = await chromium.launch({ executablePath: exe, headless: true });
for (const dark of ["0", "1"]) {
	const shots = [];
	for (const [base, comp] of sides) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
		await page.goto(`${base}?file=/text.pdf&compositor=${comp}&dark=${dark}&page=1`);
		await page.waitForFunction(() => window.__paintedMs !== undefined);
		await page.evaluate(() => {
			window.__viewer.setHighlights([
				{ id: "a", page: 1, rects: [{ x: 110, y: 120, w: 380, h: 12 }], color: [1, 0.85, 0.2, 0.45] },
				{ id: "b", page: 1, rects: [{ x: 110, y: 160, w: 300, h: 12 }], style: "outline", color: [0.2, 0.5, 1, 1] },
				{ id: "c", page: 1, rects: [{ x: 110, y: 200, w: 300, h: 12 }], style: "underline", color: [0.9, 0.2, 0.2, 1] },
			]);
		});
		await page.waitForTimeout(2500);
		await page.mouse.move(300, 420);
		await page.mouse.down();
		for (let i = 1; i <= 20; i++) await page.mouse.move(300 + i * 15, 420 + i * 3);
		await page.mouse.up();
		await page.waitForTimeout(1500);
		await page.evaluate(() => (document.getElementById("hud").style.display = "none"));
		shots.push(await page.screenshot());
		await page.close();
	}
	const page = await browser.newPage();
	const r = await page.evaluate(
		async ([a, b]) => {
			const load = async (s) => {
				const i = new Image();
				i.src = `data:image/png;base64,${s}`;
				await i.decode();
				const c = new OffscreenCanvas(i.width, i.height);
				const x = c.getContext("2d");
				x.drawImage(i, 0, 0);
				return x.getImageData(0, 0, i.width, i.height).data;
			};
			const A = await load(a);
			const B = await load(b);
			let sum = 0;
			let big = 0;
			let diff = 0;
			for (let i = 0; i < A.length; i += 4) {
				const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
				sum += d;
				if (d > 0) diff++;
				if (d > 24) big++;
			}
			const n = A.length / 4;
			return { meanAbs: +(sum / n).toFixed(3), pctAny: +((100 * diff) / n).toFixed(3), pctOver24: +((100 * big) / n).toFixed(3) };
		},
		[shots[0].toString("base64"), shots[1].toString("base64")],
	);
	await page.close();
	console.log(JSON.stringify({ compare: sides.map(([u, c]) => `${c}@${u}`).join(" vs "), dark: dark === "1", ...r }));
}
await browser.close();
