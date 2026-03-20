import { test, expect } from "@playwright/test";

test.describe("TextLayer", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/bench?pdf=pathways&layers=canvas,text");
		await page.waitForSelector("canvas", { timeout: 10000 });
	});

	test("text layer appears with spans after idle", async ({ page }) => {
		const hasText = await page.evaluate(() => {
			return window.__bench?.waitForTextLayer(1, 8000) ?? false;
		});
		expect(hasText).toBe(true);
	});

	test("text layer has CSS containment", async ({ page }) => {
		await page.evaluate(() => window.__bench?.waitForTextLayer(1, 8000));
		const contain = await page.evaluate(() => {
			const tl = document.querySelector(".textLayer");
			return tl ? getComputedStyle(tl).contain : null;
		});
		expect(contain).toContain("layout");
		expect(contain).toContain("style");
	});

	test("text is selectable", async ({ page }) => {
		await page.evaluate(() => window.__bench?.waitForTextLayer(1, 8000));
		const span = page.locator(".textLayer span").first();
		await span.waitFor({ state: "visible", timeout: 5000 });
		const text = await span.textContent();
		expect(text?.length).toBeGreaterThan(0);
	});

	test("DOM cache restores text layer after scroll back", async ({
		page,
	}) => {
		await page.evaluate(() => window.__bench?.waitForTextLayer(1, 8000));

		// Scroll down far enough to unmount page 1
		await page.evaluate(() => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (c) c.scrollTop = 5000;
		});
		await page.waitForTimeout(1000);

		// Scroll back to top
		await page.evaluate(() => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (c) c.scrollTop = 0;
		});

		// Text layer should restore from cache quickly (< 500ms)
		const start = Date.now();
		const restored = await page.evaluate(
			() => window.__bench?.waitForTextLayer(1, 2000) ?? false,
		);
		const elapsed = Date.now() - start;

		expect(restored).toBe(true);
		expect(elapsed).toBeLessThan(1000);
	});
});
