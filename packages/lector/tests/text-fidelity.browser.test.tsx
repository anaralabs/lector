import { expect, test } from "vitest";
import { calculateHighlightRects } from "../src/hooks/search/useSearchPosition";
import { acquireDocumentText } from "../src/lib/document-text";
import { loadPdfJs } from "../src/lib/pdfjs";
import { searchDocument, searchDocumentAsync } from "../src/lib/search";
import { createTextGeometryPdf } from "./fixtures/text-geometry";

for (const rotation of [0, 90, 180, 270]) {
	test(`real PDF line-aware search keeps highlight geometry at rotation ${rotation}`, async () => {
		const pdfjs = await loadPdfJs();
		pdfjs.GlobalWorkerOptions.workerSrc = new URL(
			"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
			import.meta.url,
		).href;
		const task = pdfjs.getDocument({
			data: createTextGeometryPdf({
				rotation,
				crop: true,
				operators:
					"BT /F1 20 Tf 1 0 0 1 100 600 Tm (Introduction) Tj 1 0 0 1 100 550 Tm (A first) Tj 1 0 0 1 100 520 Tm (second line.) Tj 1 0 0 1 100 470 Tm (An inter-) Tj 1 0 0 1 100 440 Tm (national study.) Tj ET",
			}),
		});
		try {
			const page = await (await task.promise).getPage(1);
			const extraction = acquireDocumentText([page]);
			try {
				const pages = await extraction.promise;
				const text = pages[0]!.text;
				expect(pages[0]!.lineBreaks!.length).toBeGreaterThanOrEqual(4);
				for (const [query, raw] of [
					["first second", "firstsecond"],
					["international", "inter-national"],
				]) {
					const options = { threshold: 1, ignoreHyphenation: true };
					const results = searchDocument(pages, query!, options);
					expect(await searchDocumentAsync(pages, query!, options)).toEqual(
						results,
					);
					expect(results.exactMatches).toHaveLength(1);
					const match = results.exactMatches[0]!;
					expect(
						text.slice(
							match.matchIndex,
							match.matchIndex + (match.matchLength ?? query!.length),
						),
					).toBe(raw);
					const actual = await calculateHighlightRects(page, match);
					const expected = await calculateHighlightRects(page, {
						pageNumber: 1,
						text: raw!,
						matchIndex: text.indexOf(raw!),
					});
					expect(actual).toEqual(expected);
					expect(actual).toHaveLength(2);
					for (const rect of actual) {
						expect(rect.width).toBeGreaterThan(0);
						expect(rect.height).toBeGreaterThan(0);
					}
				}
			} finally {
				extraction.release();
			}
		} finally {
			await task.destroy();
		}
	});
}
