import type { PDFPageProxy } from "pdfjs-dist";
import { expect, test } from "vitest";
import { acquireDocumentText } from "../src/lib/document-text";
import { searchDocument, searchDocumentAsync } from "../src/lib/search";
import {
	normalizeSearchText,
	type PageText,
} from "../src/lib/text-normalization";

test.each([
	["An ofﬁce study", "office", 3, 5],
	["A cafe\u0301 study", "café", 2, 5],
	["A café study", "cafe\u0301", 2, 4],
	["A soft\u00adhyphen study", "softhyphen", 2, 11],
	["A line\n  break study", "line break", 2, 12],
])(
	"exact search in %s finds %s with original text offsets",
	(text, query, index, length) => {
		const result = searchDocument([{ pageNumber: 1, text }], query, {
			threshold: 1,
		});
		expect(result.exactMatches).toHaveLength(1);
		const match = result.exactMatches[0]!;
		expect(match.matchIndex).toBe(index);
		expect(match.matchLength ?? query.length).toBe(length);
		expect(match.text).toBe(text.slice(index));
	},
);

test("search crosses PDF line breaks without joining separate words", async () => {
	const pages = [
		{
			pageNumber: 1,
			streamTextContent: () =>
				new ReadableStream({
					start(controller) {
						controller.enqueue({ items: [{ str: "first", hasEOL: true }] });
						controller.enqueue({ items: [{ str: "second" }] });
						controller.close();
					},
				}),
		},
	] as unknown as PDFPageProxy[];
	const task = acquireDocumentText(pages);
	try {
		const text = await task.promise;
		// Public source offsets must stay compatible with PDF.js text items.
		expect(text[0]!.text).toBe("firstsecond");
		const result = searchDocument(text, "first second", { threshold: 1 });
		expect(result.exactMatches).toHaveLength(1);
		expect(result.exactMatches[0]).toMatchObject({
			matchIndex: 0,
			matchLength: 11,
		});
		expect(
			searchDocument(text, "firstsecond", { threshold: 1 }).exactMatches,
		).toHaveLength(0);
	} finally {
		task.release();
	}
});

test.each([
	["xx oﬃce tail", "office", 3, 4],
	["😀 İ oﬃce cafe\u0301", "café", 10, 5],
	["XX ﬃ café", "ffi", 3, 1],
	["가", "가", 0, 1],
	["가", "가", 0, 2],
	["a\u0315\u0300", "à\u0315", 0, 3],
])(
	"composed normalization maps %s / %s back to original glyphs",
	(text, query, index, length) => {
		const match = searchDocument([{ pageNumber: 1, text }], query, {
			threshold: 1,
		}).exactMatches[0];
		expect(match).toBeDefined();
		expect(match!.matchIndex).toBe(index);
		expect(match!.matchLength ?? query.length).toBe(length);
	},
);

test("accent-insensitive search is opt-in and keeps the full accented span", () => {
	const pages = [{ pageNumber: 1, text: "cafe\u0301 CAFÉ" }];
	expect(
		searchDocument(pages, "cafe", { threshold: 1 }).exactMatches,
	).toHaveLength(0);
	const folded = searchDocument(pages, "cafe", {
		threshold: 1,
		matchDiacritics: false,
	});
	expect(
		folded.exactMatches.map((m) => [m.matchIndex, m.matchLength ?? 4]),
	).toEqual([
		[0, 5],
		[6, 4],
	]);
	// A different cached option must not change subsequent default searches.
	expect(
		searchDocument(pages, "cafe", { threshold: 1 }).exactMatches,
	).toHaveLength(0);
	for (const [text, query] of [
		["किताब", "कताब"],
		["x²", "x2"],
		["①", "1"],
		["a−b", "a-b"],
	]) {
		expect(
			searchDocument([{ pageNumber: 1, text: text! }], query!, {
				threshold: 1,
				matchDiacritics: false,
			}).exactMatches,
		).toHaveLength(0);
	}
});

test("line-end dehyphenation is opt-in, preserves inline compounds and original spans", () => {
	const pages: PageText[] = [
		{
			pageNumber: 1,
			text: "An inter-national state-of-the-art study",
			lineBreaks: [9],
		},
	];
	expect(
		searchDocument(pages, "international", { threshold: 1 }).exactMatches,
	).toHaveLength(0);
	const result = searchDocument(pages, "international", {
		threshold: 1,
		ignoreHyphenation: true,
	});
	expect(result.exactMatches[0]).toMatchObject({
		matchIndex: 3,
		matchLength: 14,
	});
	expect(
		searchDocument(pages, "stateoftheart", {
			threshold: 1,
			ignoreHyphenation: true,
		}).exactMatches,
	).toHaveLength(0);
	expect(
		searchDocument(
			[{ pageNumber: 1, text: "inter-\n\nnational" }],
			"international",
			{
				threshold: 1,
				ignoreHyphenation: true,
			},
		).exactMatches,
	).toHaveLength(0);
	pages[0]!.lineBreaks = [];
	expect(
		searchDocument(pages, "international", {
			threshold: 1,
			ignoreHyphenation: true,
		}).exactMatches,
	).toHaveLength(0);
});

test("Chinese and Japanese wrapped lines do not acquire spaces; Korean keeps word breaks", () => {
	for (const text of ["日本語", "ひらがな", "カタカナ"]) {
		expect(
			searchDocument([{ pageNumber: 1, text, lineBreaks: [1, 2] }], text, {
				threshold: 1,
			}).exactMatches,
		).toHaveLength(1);
	}
	expect(
		searchDocument(
			[{ pageNumber: 1, text: "한국어문서", lineBreaks: [3] }],
			"한국어 문서",
			{
				threshold: 1,
			},
		).exactMatches,
	).toHaveLength(1);
});

test("expanding one ligature does not duplicate hits or claim extra results", () => {
	const result = searchDocument([{ pageNumber: 1, text: "ﬀ ﬀ" }], "f", {
		threshold: 1,
		limit: 2,
	});
	expect(result.exactMatches.map((m) => m.matchIndex)).toEqual([0, 2]);
	expect(result.hasMoreResults).toBe(false);
});

test("empty normalized queries terminate and async/fuzzy matches retain source offsets", async () => {
	for (const query of ["\u00ad", " \u00ad "]) {
		expect(
			searchDocument([{ pageNumber: 1, text: "anything" }], query),
		).toEqual({
			exactMatches: [],
			fuzzyMatches: [],
			hasMoreResults: false,
		});
	}
	const pages = [{ pageNumber: 1, text: "İ ofﬁce\u00ad documant" }];
	const options = { threshold: 0.8 };
	const result = searchDocument(pages, "document", options);
	expect(result.fuzzyMatches[0]).toMatchObject({ matchIndex: 9, score: 0.875 });
	expect(await searchDocumentAsync(pages, "document", options)).toEqual(result);
});

test("mapping storage follows changed runs, not the number of ordinary characters", () => {
	const text = "word ".repeat(20000);
	expect(normalizeSearchText(text).maps).toEqual([]);
	const normalized = normalizeSearchText(text, {}, [5000, 10000, 15000]);
	expect(normalized.maps.flat().length).toBeLessThanOrEqual(6);
});

test("ligature fast paths retain adjacent ASCII and combining-mark glyph spans", () => {
	for (const [text, query, index, length] of [
		["aﬃ!", "ffi", 1, 1],
		["aﬃ\u0301!", "ffí", 1, 2],
		["a\u0301ﬃ!", "ffi", 2, 1],
		["ﬃﬃ!", "ffiffi", 0, 2],
	] as const) {
		const match = searchDocument([{ pageNumber: 1, text }], query, {
			threshold: 1,
		}).exactMatches[0]!;
		expect(match.matchIndex).toBe(index);
		expect(match.matchLength ?? query.length).toBe(length);
	}
});
