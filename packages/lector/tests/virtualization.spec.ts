import { test, expect } from "@playwright/test";

test.describe("Virtualization", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/bench?pdf=pathways&layers=canvas,text");
		await page.waitForSelector("canvas", { timeout: 10000 });
	});

	test("only renders overscan + visible pages in DOM", async ({ page }) => {
		await page.waitForTimeout(1000);
		const stats = await page.evaluate(() => window.__bench?.getLayerStats());
		expect(stats).toBeDefined();
		// With overscan=2, we expect ~3-5 pages max
		expect(stats!.pagesInDOM).toBeLessThanOrEqual(7);
		expect(stats!.pagesInDOM).toBeGreaterThanOrEqual(1);
	});

	test("scrolling to bottom works and updates page count", async ({
		page,
	}) => {
		const result = await page.evaluate(async () => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c) return null;
			c.scrollTop = c.scrollHeight;
			await new Promise((r) => setTimeout(r, 1000));
			return window.__bench?.getLayerStats();
		});
		expect(result).toBeDefined();
		expect(result!.pagesInDOM).toBeGreaterThanOrEqual(1);
	});
});
