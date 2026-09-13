// Run with the docs server running: DOCS_URL=http://localhost:3000 node scripts/check-docs-examples.mjs
// Set PLAYWRIGHT_EXECUTABLE_PATH to use an existing Chromium installation.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseURL = process.env.DOCS_URL ?? "http://localhost:3000";
const routes = [
	"basic",
	"page-navigation",
	"zoom-control",
	"thumbnails",
	"search",
	"highlight",
	"select",
	"links",
	"pdf-form",
];
const browser = await chromium.launch({
	headless: true,
	executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
});
const failures = [];

try {
	for (const width of (process.env.DOCS_WIDTHS ?? "1440,390")
		.split(",")
		.map(Number)) {
		const page = await browser.newPage({
			viewport: { width, height: 1000 },
			colorScheme: "dark",
		});
		await page.addInitScript(() => localStorage.setItem("theme", "system"));
		for (const route of routes) {
			try {
				await page.emulateMedia({ colorScheme: "dark" });
				await page.goto(`${baseURL}/docs/code/${route}`);
				const examples = page.locator("[data-lector-example]");
				await examples.first().waitFor({ timeout: 60000 });
				for (let index = 0; index < (await examples.count()); index++) {
					const example = examples.nth(index);
					await example.scrollIntoViewIfNeeded();
					await example
						.locator(".textLayer")
						.first()
						.waitFor({ timeout: 60000 });
					for (const theme of ["dark", "light", "dark"]) {
						await page.emulateMedia({ colorScheme: theme });
						// Poll actual canvas pixels, since theme state can update before a render completes.
						await page.waitForFunction(
							({ index, dark }) => {
								const root = document.querySelectorAll("[data-lector-example]")[
									index
								];
								const canvas = root
									?.querySelector(".textLayer")
									?.parentElement?.querySelector("canvas");
								if (!canvas || !canvas.width || !canvas.height) return false;
								const pixel = canvas
									.getContext("2d")
									.getImageData(5, 5, 1, 1).data;
								return (
									pixel[3] === 255 &&
									(dark
										? Math.max(...pixel.slice(0, 3)) < 100
										: Math.min(...pixel.slice(0, 3)) > 200)
								);
							},
							{ index, dark: theme === "dark" },
							{ timeout: 20000 },
						);
					}
					const geometry = await example
						.locator(".textLayer")
						.first()
						.evaluate((layer) => {
							const pdfPage = layer.parentElement;
							let viewport = pdfPage.parentElement;
							while (viewport && getComputedStyle(viewport).overflow !== "auto")
								viewport = viewport.parentElement;
							const p = pdfPage.getBoundingClientRect(),
								v = viewport.getBoundingClientRect();
							return {
								centerError: Math.abs(
									(p.left + p.right - v.left - v.right) / 2,
								),
								pageWidth: p.width,
								viewportWidth: v.width,
								bodyOverflow: document.documentElement.scrollWidth - innerWidth,
							};
						});
					assert(
						geometry.centerError < 3,
						`${route}: off-center ${JSON.stringify(geometry)}`,
					);
					assert(
						geometry.pageWidth <= geometry.viewportWidth + 2,
						`${route}: page clipped ${JSON.stringify(geometry)}`,
					);
					assert(
						geometry.bodyOverflow < 2,
						`${route}: document overflows horizontally`,
					);
				}
				if (process.env.DOCS_SCREENSHOTS) {
					await mkdir(process.env.DOCS_SCREENSHOTS, { recursive: true });
					await page.screenshot({
						animations: "disabled",
						path: `${process.env.DOCS_SCREENSHOTS}/${route}-${width}.png`,
					});
				}
				console.log(
					`PASS ${route} ${width}px: centered, fits, dark → light → dark canvas`,
				);
			} catch (error) {
				failures.push(`${route} ${width}px: ${error.message}`);
				console.error(`FAIL ${failures.at(-1)}`);
			}
		}
		await page.close();
	}
} finally {
	await browser.close();
}
assert.equal(failures.length, 0, failures.join("\n"));
