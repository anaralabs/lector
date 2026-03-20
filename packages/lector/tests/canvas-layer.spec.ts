import { test, expect } from "@playwright/test";

test.describe("CanvasLayer", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/bench?pdf=pathways&layers=canvas");
		await page.waitForSelector("canvas", { timeout: 10000 });
	});

	test("renders canvas elements for visible pages", async ({ page }) => {
		const canvasCount = await page.locator("canvas").count();
		expect(canvasCount).toBeGreaterThanOrEqual(2);
	});

	test("canvas has non-zero dimensions", async ({ page }) => {
		const dims = await page.evaluate(() => {
			const c = document.querySelector("canvas");
			return c ? { w: c.width, h: c.height } : null;
		});
		expect(dims).not.toBeNull();
		expect(dims!.w).toBeGreaterThan(0);
		expect(dims!.h).toBeGreaterThan(0);
	});

	test("canvas renders non-blank pixels", async ({ page }) => {
		const hasPixels = await page.evaluate(() => {
			const c = document.querySelector("canvas");
			if (!c) return false;
			const ctx = c.getContext("2d");
			if (!ctx) return false;
			const data = ctx.getImageData(0, 0, c.width, c.height).data;
			let nonWhite = 0;
			for (let i = 0; i < data.length; i += 4) {
				if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
					nonWhite++;
				}
			}
			return nonWhite > 100;
		});
		expect(hasPixels).toBe(true);
	});
});
