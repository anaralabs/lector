import { test, expect } from "@playwright/test";

const LAYER_CONFIGS = [
	{ name: "canvas_only", layers: "canvas", p95Threshold: 100 },
	{ name: "canvas_text", layers: "canvas,text", p95Threshold: 150 },
	{
		name: "canvas_text_annotation",
		layers: "canvas,text,annotation",
		p95Threshold: 250,
	},
	{ name: "all_layers", layers: "all", p95Threshold: 300 },
];

test.describe("Scroll performance", () => {
	for (const config of LAYER_CONFIGS) {
		test(`fast flick - ${config.name} (p95 < ${config.p95Threshold}ms)`, async ({
			page,
		}) => {
			await page.goto(
				`/bench?pdf=pathways&layers=${config.layers}`,
			);
			await page.waitForSelector("canvas", { timeout: 15000 });
			await page.waitForTimeout(2000);

			const result = await page.evaluate(
				() => window.__bench?.fastFlick(800),
			);
			expect(result).toBeDefined();
			expect(result!.frames).toBeGreaterThan(5);

			console.log(
				`[perf] ${config.name}: p50=${result!.p50}ms p95=${result!.p95}ms max=${result!.max}ms over100=${result!.over100}`,
			);

			expect(Number.parseFloat(result!.p95)).toBeLessThan(
				config.p95Threshold,
			);
		});
	}

	test("warm scroll is faster than cold scroll (bitmap cache)", async ({
		page,
	}) => {
		await page.goto("/bench?pdf=pathways&layers=canvas,text");
		await page.waitForSelector("canvas", { timeout: 15000 });
		await page.waitForTimeout(2000);

		// Cold scroll
		const cold = await page.evaluate(() => window.__bench?.fastFlick(800));
		expect(cold).toBeDefined();

		await page.waitForTimeout(2000);

		// Warm scroll (pages are in bitmap cache)
		const warm = await page.evaluate(() => window.__bench?.fastFlick(800));
		expect(warm).toBeDefined();

		console.log(
			`[perf] cold p95=${cold!.p95}ms warm p95=${warm!.p95}ms`,
		);

		// Warm scroll should have fewer frames over 100ms
		expect(warm!.over100).toBeLessThanOrEqual(cold!.over100);
	});
});
