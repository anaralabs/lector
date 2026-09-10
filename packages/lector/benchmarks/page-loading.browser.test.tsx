import { expect, test } from "vitest";
import { mapConcurrent } from "../src/lib/map-concurrent";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "../tests/fixtures/pdf";

test("compare page-request concurrency on real PDF.js documents", async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	const large = new Uint8Array(
		await (
			await fetch(new URL("../../docs/public/pdf/large.pdf", import.meta.url))
		).arrayBuffer(),
	);
	for (const [name, data] of [
		["generated-1000", createTextPdf(1000)],
		["large-320", large],
	] as const) {
		const samples = new Map<number, number[]>();
		for (let run = 0; run < 4; run++) {
			// Alternate order to reduce systematic warmup/thermal bias.
			const limits = run % 2 ? [1000, 64, 32, 16] : [16, 32, 64, 1000];
			for (const limit of limits) {
				const task = pdfjs.getDocument({ data: data.slice() });
				try {
					const pdf = await task.promise;
					const start = performance.now();
					const viewports = await mapConcurrent(
						Array.from({ length: pdf.numPages }, (_, i) => i + 1),
						limit,
						async (page) => (await pdf.getPage(page)).getViewport({ scale: 1 }),
					);
					const ms = performance.now() - start;
					expect(viewports).toHaveLength(pdf.numPages);
					if (run > 0)
						samples.set(limit, [...(samples.get(limit) ?? []), +ms.toFixed(1)]);
				} finally {
					await task.destroy();
				}
			}
		}
		console.info(
			`PAGE_LOADING ${JSON.stringify({ name, samples: Object.fromEntries(samples) })}`,
		);
	}
}, 60000);
