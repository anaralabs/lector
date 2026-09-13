import { expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { acquireDocumentText } from "../src/lib/document-text";
import { mapConcurrent } from "../src/lib/map-concurrent";
import { loadPdfJs } from "../src/lib/pdfjs";
import { searchDocumentAsync } from "../src/lib/search";

declare const __LECTOR_SOAK_CPU_RATE__: number;

// Fresh page identities deliberately include first-query normalization costs.
const makePages = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		pageNumber: index + 1,
		text: "The ofﬁce library renders searchable documents with café notes and efficient page navigation. ".repeat(
			12,
		),
	}));

test("low-end search latency and event-loop responsiveness", async () => {
	const protocol = cdp();
	await protocol.send("Emulation.setCPUThrottlingRate", {
		rate: __LECTOR_SOAK_CPU_RATE__,
	});
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	const document = await pdfjs.getDocument(
		new URL("../../docs/public/pdf/large.pdf", import.meta.url).href,
	).promise;
	let indexing: ReturnType<typeof acquireDocumentText> | undefined;
	try {
		const proxies = await mapConcurrent(
			Array.from({ length: document.numPages }, (_, i) => i + 1),
			16,
			(n) => document.getPage(n),
		);
		indexing = acquireDocumentText(proxies);
		const realPages = await indexing.promise;
		for (const scenario of [
			{ name: "real-common-exact", count: 0, query: "the", threshold: 1 },
			{
				name: "real-absent-exact",
				count: 0,
				query: "unfindable-needle",
				threshold: 1,
			},
			{ name: "common-exact", count: 1000, query: "library", threshold: 1 },
			{
				name: "absent-exact",
				count: 1000,
				query: "unfindable-needle",
				threshold: 1,
			},
			{
				name: "fuzzy-typo",
				count: 100,
				query: "efficient page navigatoin",
				threshold: 0.7,
			},
		]) {
			for (let run = 0; run <= 7; run++) {
				const pages = scenario.count
					? makePages(scenario.count)
					: realPages.map((page) => ({ ...page }));
				let inputDelayMs = 0;
				const start = performance.now();
				const input = new Promise<void>((resolve) =>
					setTimeout(() => {
						inputDelayMs = performance.now() - start;
						resolve();
					}, 0),
				);
				const result = await searchDocumentAsync(pages, scenario.query, {
					threshold: scenario.threshold,
				});
				const totalMs = performance.now() - start;
				await input;
				expect(result.exactMatches.length + result.fuzzyMatches.length).toBe(
					scenario.name.includes("absent-exact") ? 0 : 10,
				);
				if (run)
					console.log(
						"LOW_END_SEARCH",
						JSON.stringify({
							scenario: scenario.name,
							run,
							cpuRate: __LECTOR_SOAK_CPU_RATE__,
							characters: pages.reduce(
								(sum, page) => sum + page.text.length,
								0,
							),
							totalMs,
							inputDelayMs,
						}),
					);
			}
		}
	} finally {
		indexing?.release();
		await document.destroy();
		await protocol.send("Emulation.setCPUThrottlingRate", { rate: 1 });
	}
}, 120000);
