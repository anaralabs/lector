import type { SearchResult, SearchResults } from "../hooks/search/useSearch";

import {
	type NormalizedText,
	normalizeSearchText,
	originalTextRange,
	type PageText,
	type TextNormalizationOptions,
} from "./text-normalization";

export interface SearchOptions extends TextNormalizationOptions {
	threshold?: number;
	limit?: number;
	textSize?: number;
}

type SearchPage = PageText;
// Share lazily built variants between hooks; releasing the document releases
// every variant. Immutable line-break metadata is part of the cache identity.
const normalizedPages = new WeakMap<
	SearchPage,
	{
		text: string;
		lineBreaks?: readonly number[];
		variants: Map<number, NormalizedText>;
	}
>();
function normalize(page: SearchPage, options: SearchOptions): NormalizedText {
	let cached = normalizedPages.get(page);
	if (cached?.text !== page.text || cached.lineBreaks !== page.lineBreaks) {
		cached = {
			text: page.text,
			lineBreaks: page.lineBreaks,
			variants: new Map(),
		};
		normalizedPages.set(page, cached);
	}
	const key =
		(options.matchDiacritics === false ? 1 : 0) |
		(options.ignoreHyphenation ? 2 : 0);
	let result = cached.variants.get(key);
	if (!result) {
		result = normalizeSearchText(page.text, options, page.lineBreaks);
		cached.variants.set(key, result);
	}
	return result;
}

function createMatch(
	page: SearchPage,
	normalized: NormalizedText,
	start: number,
	length: number,
	searchText: string,
	textSize: number,
	score: number,
): SearchResult {
	const end = Math.min(normalized.text.length, start + length);
	const { start: matchIndex, end: matchEnd } = originalTextRange(
		normalized,
		start,
		end,
	);
	const matchLength = matchEnd - matchIndex;
	return {
		pageNumber: page.pageNumber,
		text: page.text.slice(matchIndex, matchEnd + textSize),
		score,
		matchIndex,
		isExactMatch: score === 1,
		searchText,
		...(matchLength !== searchText.length ? { matchLength } : {}),
	};
}

/** Reuses two rows across candidate windows and only visits the edit band. */
export function createBoundedDistance(query: string, maxDistance: number) {
	const length = query.length;
	let previous = new Float64Array(length + 1);
	let current = new Float64Array(length + 1);
	const exceeded = maxDistance + 1;
	return (text: string, offset: number): number => {
		const size = Math.min(length, text.length - offset);
		if (length - size > maxDistance) return exceeded;
		for (let j = 0; j <= length; j++) previous[j] = j;
		for (let i = 1; i <= size; i++) {
			const start = Math.max(1, i - maxDistance);
			const end = Math.min(length, i + maxDistance);
			current[0] = i;
			if (start > 1) current[start - 1] = exceeded;
			let minimum = exceeded;
			const code = text.charCodeAt(offset + i - 1);
			for (let j = start; j <= end; j++) {
				const value = Math.min(
					previous[j]! + 1,
					current[j - 1]! + 1,
					previous[j - 1]! + (query.charCodeAt(j - 1) === code ? 0 : 1),
				);
				current[j] = value;
				minimum = Math.min(minimum, value);
			}
			if (end < length) current[end + 1] = exceeded;
			if (minimum > maxDistance) return exceeded;
			[previous, current] = [current, previous];
		}
		return previous[length]!;
	};
}

// Keep only the best `limit` candidates; ties retain document order.
function insertMatch(
	matches: SearchResult[],
	match: SearchResult,
	limit: number,
) {
	if (
		!limit ||
		(matches.length === limit && matches[limit - 1]!.score >= match.score)
	)
		return;
	let low = 0;
	let high = matches.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (matches[mid]!.score >= match.score) low = mid + 1;
		else high = mid;
	}
	matches.splice(low, 0, match);
	if (matches.length > limit) matches.pop();
}

function* runSearch(
	pages: SearchPage[],
	searchText: string,
	options: SearchOptions = {},
	cooperative = false,
	budget = 8,
): Generator<void, SearchResults> {
	const empty = { exactMatches: [], fuzzyMatches: [], hasMoreResults: false };
	if (!searchText.trim()) return empty;
	const threshold = Math.max(0, Math.min(1, options.threshold ?? 0.7));
	const limit = Number.isFinite(options.limit)
		? Math.max(0, Math.floor(options.limit!))
		: 10;
	const textSize = options.textSize ?? 100;
	const query = normalizeSearchText(searchText, options).text;
	if (!query.trim()) return empty;
	const maxDistance = Math.floor(query.length * (1 - threshold));
	const distance =
		maxDistance > 0 ? createBoundedDistance(query, maxDistance) : null;
	const exactMatches: SearchResult[] = [];
	const fuzzyMatches: SearchResult[] = [];
	let exactCount = 0;
	let fuzzyCount = 0;
	let steps = 0;
	let deadline = cooperative ? performance.now() + budget : 0;

	for (const page of pages) {
		// A page with no matches still spends time normalizing and scanning.
		// Check its budget even when neither matching loop reaches 128 steps.
		if (cooperative && performance.now() >= deadline) {
			yield;
			deadline = performance.now() + budget;
		}
		const normalized = normalize(page, options);
		const lower = normalized.text;
		// Ranges belong to this page. Storing every covered character wastes
		// memory and sharing offsets across pages hides legitimate matches.
		const exactStarts: number[] = [];
		let index = 0;
		let lastStart = -1;
		let lastEnd = -1;
		while (true) {
			if (
				cooperative &&
				(++steps & 127) === 0 &&
				performance.now() >= deadline
			) {
				yield;
				deadline = performance.now() + budget;
			}
			const matchIndex = lower.indexOf(query, index);
			if (matchIndex === -1) break;
			const span = originalTextRange(
				normalized,
				matchIndex,
				matchIndex + query.length,
			);
			index = matchIndex + query.length;
			if (maxDistance > 0) exactStarts.push(matchIndex);
			// A query for "f" in the single glyph ﬀ should yield one highlight.
			if (span.start === lastStart && span.end === lastEnd) continue;
			lastStart = span.start;
			lastEnd = span.end;
			exactCount++;
			// Exact results are already in their final document order. One extra
			// distinct hit proves hasMoreResults; further pages cannot change it.
			if (maxDistance === 0 && exactCount > limit) {
				return { exactMatches, fuzzyMatches, hasMoreResults: true };
			}
			if (exactMatches.length < limit) {
				exactMatches.push(
					createMatch(
						page,
						normalized,
						matchIndex,
						query.length,
						searchText,
						textSize,
						1,
					),
				);
			}
			index = matchIndex + query.length;
		}

		if (!(maxDistance > 0)) continue;
		index = 0;
		let exactIndex = 0;
		while (index < lower.length) {
			if (
				cooperative &&
				(++steps & 127) === 0 &&
				performance.now() >= deadline
			) {
				yield;
				deadline = performance.now() + budget;
			}
			while (
				exactIndex < exactStarts.length &&
				exactStarts[exactIndex]! + query.length <= index
			)
				exactIndex++;
			const exactStart = exactStarts[exactIndex];
			if (exactStart !== undefined && index >= exactStart) {
				index = exactStart + query.length;
				continue;
			}
			const edits = distance!(lower, index);
			if (edits > 0 && edits <= maxDistance) {
				fuzzyCount++;
				const score = 1 - edits / query.length;
				if (
					fuzzyMatches.length < limit ||
					score > (fuzzyMatches[limit - 1]?.score ?? Infinity)
				) {
					insertMatch(
						fuzzyMatches,
						createMatch(
							page,
							normalized,
							index,
							query.length,
							searchText,
							textSize,
							score,
						),
						limit,
					);
				}
				index += query.length;
			} else index++;
		}
	}
	// Preserve the exact/fuzzy split when both are available, then fill unused
	// slots. Previously exact-only queries returned half the requested limit.
	const exactLimit = Math.min(
		exactCount,
		Math.max(Math.ceil(limit / 2), limit - fuzzyCount),
	);
	return {
		exactMatches: exactMatches.slice(0, exactLimit),
		fuzzyMatches: fuzzyMatches.slice(0, limit - exactLimit),
		hasMoreResults: exactCount + fuzzyCount > limit,
	};
}

export function searchDocument(
	pages: SearchPage[],
	searchText: string,
	options: SearchOptions = {},
): SearchResults {
	// The synchronous iterator never yields; both APIs use identical ranking.
	return runSearch(pages, searchText, options).next().value as SearchResults;
}

export interface AsyncSearchOptions extends SearchOptions {
	/** Cancelling rejects with AbortError and never publishes partial results. */
	signal?: AbortSignal;
	/** Approximate work budget between yields; defaults to 8 ms. */
	timeSliceMs?: number;
}

export async function searchDocumentAsync(
	pages: SearchPage[],
	searchText: string,
	options: AsyncSearchOptions = {},
): Promise<SearchResults> {
	const budget = Number.isFinite(options.timeSliceMs)
		? Math.max(1, options.timeSliceMs!)
		: 8;
	const iterator = runSearch(pages, searchText, options, true, budget);
	while (true) {
		if (options.signal?.aborted)
			throw new DOMException("Search aborted", "AbortError");
		const result = iterator.next();
		if (result.done) return result.value;
		// Message tasks yield to input/rendering without the nested setTimeout
		// clamp. Close both ports after every task, including cancelled searches.
		await new Promise<void>((resolve) => {
			if (typeof MessageChannel === "undefined") {
				setTimeout(resolve, 0);
				return;
			}
			const channel = new MessageChannel();
			channel.port1.onmessage = () => {
				channel.port1.close();
				channel.port2.close();
				resolve();
			};
			channel.port2.postMessage(null);
		});
	}
}
