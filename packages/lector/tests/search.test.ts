import { expect, test } from "vitest";
import { createBoundedDistance, searchDocument } from "../src/lib/search";

function referenceDistance(a: string, b: string): number {
	const matrix = Array.from({ length: b.length + 1 }, (_, i) =>
		Array.from({ length: a.length + 1 }, (_, j) =>
			i === 0 ? j : j === 0 ? i : 0,
		),
	);
	for (let i = 1; i <= b.length; i++)
		for (let j = 1; j <= a.length; j++)
			matrix[i]![j] = Math.min(
				matrix[i - 1]![j]! + 1,
				matrix[i]![j - 1]! + 1,
				matrix[i - 1]![j - 1]! + (a[j - 1] === b[i - 1] ? 0 : 1),
			);
	return matrix[b.length]![a.length]!;
}

test("bounded distance agrees with full Levenshtein across 20,000 seeded windows", () => {
	let seed = 17;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	const word = (size: number) =>
		Array.from({ length: size }, () => "abcé😀"[random() % 6]).join("");
	for (let i = 0; i < 200; i++) {
		const query = word(1 + (random() % 30));
		const max = random() % (query.length + 1);
		const distance = createBoundedDistance(query, max);
		for (let j = 0; j < 100; j++) {
			const text = word(random() % 50);
			const offset = random() % (text.length + 1);
			const expected = referenceDistance(
				query,
				text.slice(offset, offset + query.length),
			);
			const actual = distance(text, offset);
			expect(actual <= max ? actual : max + 1).toBe(
				Math.min(expected, max + 1),
			);
		}
	}
});

test("fuzzy ranking retains best matches and stable ties with bounded results", () => {
	const pages = ["documant", "documxxx", "documant", "documant"].map(
		(text, i) => ({ pageNumber: i + 1, text }),
	);
	const result = searchDocument(pages, "document", { limit: 2 });
	expect(result.fuzzyMatches.map((x) => x.pageNumber)).toEqual([1, 3]);
	expect(result.hasMoreResults).toBe(true);
});

test("zero limits, thresholds, shorter tail windows and replaced text are safe", () => {
	const pages = [{ pageNumber: 1, text: "documen" }];
	expect(searchDocument(pages, "document").fuzzyMatches[0]?.score).toBe(0.875);
	expect(searchDocument(pages, "document", { limit: 0 })).toEqual({
		exactMatches: [],
		fuzzyMatches: [],
		hasMoreResults: true,
	});
	pages[0]!.text = "document";
	expect(
		searchDocument(pages, "document", { threshold: 1 }).exactMatches,
	).toHaveLength(1);
});

test("Unicode case expansion preserves original offsets, snippets and match lengths", () => {
	for (const [text, query, index, length] of [
		["İ document", "document", 2, 8],
		["İ documant", "document", 2, 8],
		["İİ", "i\u0307", 0, 1],
		["i\u0307!", "İ", 0, 2],
		["😀 İ document", "document", 5, 8],
	] as const) {
		const results = searchDocument([{ pageNumber: 1, text }], query);
		const match = [...results.exactMatches, ...results.fuzzyMatches][0]!;
		expect(match.matchIndex).toBe(index);
		expect(match.text).toBe(text.slice(index));
		expect(match.matchLength ?? query.length).toBe(length);
	}
	const matches = searchDocument([{ pageNumber: 1, text: "İİ" }], "i\u0307", {
		threshold: 1,
	});
	expect(matches.exactMatches.map((match) => match.matchIndex)).toEqual([0, 1]);
	// Preserve whole-string lowercasing, including context-sensitive Greek sigma.
	expect(
		searchDocument([{ pageNumber: 1, text: "İ ΟΣ" }], "ος", { threshold: 1 })
			.exactMatches[0]?.matchIndex,
	).toBe(2);
});
