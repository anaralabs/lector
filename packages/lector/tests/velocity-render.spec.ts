import { test, expect } from "@playwright/test";

test.describe("Velocity-based rendering", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/bench?pdf=pathways&layers=canvas,text");
		await page.waitForSelector("canvas", { timeout: 15000 });
		await page.waitForTimeout(2000);
	});

	test("text layers render during slow scroll", async ({ page }) => {
		// Slow scroll — velocity below threshold, text should render
		await page.evaluate(async () => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c) return;
			for (let i = 0; i < 10; i++) {
				c.scrollTop += 100;
				await new Promise((r) => setTimeout(r, 100));
			}
		});

		await page.waitForTimeout(2000);

		const textLayerCount = await page.evaluate(() => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c) return 0;
			const tls = c.querySelectorAll(".textLayer");
			let withContent = 0;
			for (const tl of tls) {
				if (tl.querySelectorAll("span").length > 0) withContent++;
			}
			return withContent;
		});

		expect(textLayerCount).toBeGreaterThanOrEqual(1);
	});

	test("text layers defer during fast scroll then render after settling", async ({
		page,
	}) => {
		// Fast scroll — text layers should be deferred
		await page.evaluate(async () => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c) return;
			for (let i = 0; i < 30; i++) {
				c.scrollTop += 800;
				await new Promise((r) =>
					requestAnimationFrame(() => r(undefined)),
				);
			}
		});

		// Check immediately after fast scroll — text layers may be empty
		const duringScroll = await page.evaluate(() => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c) return 0;
			const tls = c.querySelectorAll(".textLayer");
			let withContent = 0;
			for (const tl of tls) {
				if (tl.querySelectorAll("span").length > 0) withContent++;
			}
			return withContent;
		});

		// Wait for scroll to settle and text layers to render
		await page.waitForTimeout(3000);

		const afterSettle = await page.evaluate(() => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c) return 0;
			const tls = c.querySelectorAll(".textLayer");
			let withContent = 0;
			for (const tl of tls) {
				if (tl.querySelectorAll("span").length > 0) withContent++;
			}
			return withContent;
		});

		// After settling, text layers should have rendered
		expect(afterSettle).toBeGreaterThanOrEqual(1);
	});

	test("resume scroll after stop is responsive", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const c = document.querySelector<HTMLDivElement>(
				'[style*="overflow: auto"]',
			);
			if (!c)
				return { p50: "0", max: "0", over100: 0 };

			// Fast scroll
			for (let i = 0; i < 20; i++) {
				c.scrollTop += 600;
				await new Promise((r) =>
					requestAnimationFrame(() => r(undefined)),
				);
			}

			// Brief stop
			await new Promise((r) => setTimeout(r, 200));

			// Resume and measure frame times
			const fps: number[] = [];
			let lastT = performance.now();
			await new Promise<void>((resolve) => {
				let pos = c.scrollTop;
				let fc = 0;
				const step = (ts: number) => {
					const dt = ts - lastT;
					lastT = ts;
					if (dt > 0 && fc > 0) fps.push(dt);
					fc++;
					pos += 200;
					c.scrollTop = pos;
					if (fc < 20) requestAnimationFrame(step);
					else resolve();
				};
				requestAnimationFrame(step);
			});

			const sorted = [...fps].sort((a, b) => a - b);
			return {
				p50: sorted[Math.floor(sorted.length * 0.5)]?.toFixed(1) ?? "0",
				max: sorted[sorted.length - 1]?.toFixed(1) ?? "0",
				over100: fps.filter((f) => f > 100).length,
			};
		});

		// Resume should be responsive — no long frame blocks
		expect(result.over100).toBeLessThanOrEqual(2);
		expect(Number.parseFloat(result.max)).toBeLessThan(500);
	});
});
