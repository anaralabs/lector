// Run the docs app first: pnpm --filter docs dev --port 3017
// Optional screenshots: LECTOR_SCREENSHOTS=/absolute/path
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	await page.goto(process.env.LECTOR_READER_URL ?? "http://localhost:3017", {
		waitUntil: "networkidle",
	});
	const reader = page.locator(".reader-shell");
	await reader.locator("canvas").first().waitFor();
	await reader.getByRole("button", { name: "Next page" }).focus();
	await page.keyboard.press("Enter");
	await page.waitForFunction(
		() => document.querySelector(".page-count")?.textContent === "2/15",
	);
	await reader.getByRole("button", { name: "Previous page" }).click();
	await page.waitForFunction(
		() => document.querySelector(".page-count")?.textContent === "1/15",
	);
	const zoom = reader.getByRole("button", { name: "Fit page to width" });
	const initialZoom = Number.parseInt(await zoom.textContent(), 10);
	await reader.getByRole("button", { name: "Zoom in" }).click();
	assert(Number.parseInt(await zoom.textContent(), 10) > initialZoom);
	await zoom.click();
	const positions = () =>
		reader
			.locator(".reader-controls button, .reader-controls a")
			.evaluateAll((nodes) =>
				nodes.map((node) => {
					const { x, y, width, height } = node.getBoundingClientRect();
					const shell = node.closest(".reader-shell").getBoundingClientRect();
					// Browser automation scrolls the outer page to reach the selection.
					return { x: x - shell.x, y: y - shell.y, width, height };
				}),
			);
	const before = await positions();
	await reader
		.locator(".textLayer span")
		.filter({ hasText: "Attention Is All You Need" })
		.first()
		.evaluate((node) => {
			const range = document.createRange();
			range.selectNodeContents(node);
			window.getSelection().removeAllRanges();
			window.getSelection().addRange(range);
		});
	await reader.getByRole("button", { name: "Highlight", exact: true }).click();
	const clear = reader.getByRole("button", { name: "Clear highlights" });
	assert(await clear.isEnabled());
	assert.deepEqual(
		await positions(),
		before,
		"Highlight creation must not move toolbar controls",
	);
	await clear.click();
	assert(await clear.isDisabled());

	for (const width of [320, 375, 390, 768, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await reader.scrollIntoViewIfNeeded();
		// Let the 100 ms zoom debounce and newly visible canvases settle for visual QA.
		await page.waitForTimeout(500);
		const metrics = await positions();
		if (width <= 600)
			for (const target of metrics) {
				assert(target.width >= 44 && target.height >= 44);
			}
		assert(
			await reader.evaluate((node) => node.scrollWidth === node.clientWidth),
			`Reader overflow at ${width}px`,
		);
		if (process.env.LECTOR_SCREENSHOTS) {
			await mkdir(process.env.LECTOR_SCREENSHOTS, { recursive: true });
			await reader.screenshot({
				path: `${process.env.LECTOR_SCREENSHOTS}/reader-${width}.png`,
			});
		}
		console.log(JSON.stringify({ width, targets: metrics }));
	}
	console.log(
		"Reader navigation, zoom, selection, stable controls and responsive targets passed.",
	);
} finally {
	await browser.close();
}
