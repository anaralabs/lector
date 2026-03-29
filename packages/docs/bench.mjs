import { writeFile } from "node:fs/promises";

import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BENCH_BASE_URL ?? "http://127.0.0.1:3000";
const OUTPUT_PATH =
	process.env.BENCH_OUTPUT_PATH ?? "/opt/cursor/artifacts/text-layer-bench.json";

const PDFS = [
	{ key: "pathways", label: "Pathways" },
	{ key: "large", label: "Large" },
	{ key: "research", label: "Research Paper" },
];

const CPU_RATES = [
	{ label: "1x", rate: 1 },
	{ label: "4x", rate: 4 },
];

const MODES = ["pretext", "pdfjs"];

const percentile = (values, ratio) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor((sorted.length - 1) * ratio)),
	);
	return sorted[index] ?? null;
};

const summarizePair = (results) => {
	const byKey = new Map(
		results.map((result) => [`${result.pdf}:${result.cpu}:${result.requestedMode}`, result]),
	);

	return results
		.filter((result) => result.requestedMode === "pretext")
		.map((pretextResult) => {
			const pdfjsResult = byKey.get(
				`${pretextResult.pdf}:${pretextResult.cpu}:pdfjs`,
			);

			return {
				pdf: pretextResult.pdf,
				cpu: pretextResult.cpu,
				pretextReadyMs: pretextResult.textLayerReadyMs,
				pdfjsReadyMs: pdfjsResult?.textLayerReadyMs ?? null,
				readyDeltaMs:
					pretextResult.textLayerReadyMs != null &&
					pdfjsResult?.textLayerReadyMs != null
						? pretextResult.textLayerReadyMs - pdfjsResult.textLayerReadyMs
						: null,
				pretextP95: pretextResult.p95FrameMs,
				pdfjsP95: pdfjsResult?.p95FrameMs ?? null,
				p95DeltaMs:
					pretextResult.p95FrameMs != null && pdfjsResult?.p95FrameMs != null
						? pretextResult.p95FrameMs - pdfjsResult.p95FrameMs
						: null,
			};
		});
};

const browser = await puppeteer.launch({
	headless: "new",
	executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/google-chrome",
	args: ["--no-sandbox", "--disable-setuid-sandbox"],
	defaultViewport: {
		width: 1440,
		height: 1000,
		deviceScaleFactor: 1,
	},
});

const page = await browser.newPage();
const session = await page.target().createCDPSession();

await page.goto(`${BASE_URL}/bench`, {
	waitUntil: "networkidle2",
	timeout: 120000,
});

await page.waitForFunction(() => typeof window.__bench?.runComparison === "function", {
	timeout: 120000,
});

const results = [];

for (const cpu of CPU_RATES) {
	await session.send("Emulation.setCPUThrottlingRate", { rate: cpu.rate });

	for (const pdf of PDFS) {
		const runResults = await page.evaluate(
			async ({ nextPdf, modes }) => {
				return window.__bench.runComparison({
					pdf: nextPdf,
					modes,
					scrollDurationMs: 3000,
				});
			},
			{
				nextPdf: pdf.key,
				modes: MODES,
			},
		);

		for (const result of runResults) {
			results.push({
				...result,
				pdf: pdf.label,
				cpu: cpu.label,
			});
		}
	}
}

await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await browser.close();

const summary = summarizePair(results);
const aggregate = {
	pretextReadyMedianDeltaMs: percentile(
		summary
			.map((row) => row.readyDeltaMs)
			.filter((value) => typeof value === "number"),
		0.5,
	),
	pretextP95MedianDeltaMs: percentile(
		summary
			.map((row) => row.p95DeltaMs)
			.filter((value) => typeof value === "number"),
		0.5,
	),
};

const output = {
	baseUrl: BASE_URL,
	generatedAt: new Date().toISOString(),
	results,
	summary,
	aggregate,
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(JSON.stringify(output, null, 2));
