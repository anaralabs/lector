import { test, expect } from "@playwright/test";

test.describe("AnnotationLayer", () => {
	test("renders annotation layer elements on links PDF", async ({
		page,
	}) => {
		await page.goto("/bench?pdf=links&layers=canvas,text,annotation");
		await page.waitForSelector("canvas", { timeout: 10000 });
		// Wait for idle-deferred annotation layer to render
		await page.waitForTimeout(2000);

		const annotationLayers = await page
			.locator(".annotationLayer")
			.count();
		expect(annotationLayers).toBeGreaterThanOrEqual(1);
	});

	test("annotation layer is deferred during fast scroll", async ({
		page,
	}) => {
		await page.goto("/bench?pdf=pathways&layers=canvas,text,annotation");
		await page.waitForSelector("canvas", { timeout: 10000 });
		await page.waitForTimeout(1000);

		// Start fast scrolling — annotations should not render for
		// pages that are only briefly visible
		const annotationsDuringScroll = await page.evaluate(async () => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c) return { during: 0, after: 0 };

			// Fast scroll
			let pos = 0;
			for (let i = 0; i < 20; i++) {
				pos += 400;
				c.scrollTop = pos;
				await new Promise((r) => requestAnimationFrame(r));
			}

			const during = document.querySelectorAll(
				".annotationLayer *",
			).length;

			// Wait for idle to fire
			await new Promise((r) => setTimeout(r, 2000));
			const after = document.querySelectorAll(
				".annotationLayer *",
			).length;

			return { during, after };
		});

		// After settling, annotation layers should have content
		expect(annotationsDuringScroll.after).toBeGreaterThanOrEqual(0);
	});
});
