import type { SearchResult, SearchResults } from "../hooks/search/useSearch";

export interface SearchOptions {
	threshold?: number;
	limit?: number;
	textSize?: number;
}

type SearchPage = { pageNumber: number; text: string };
// Weak keys let replaced documents be collected; no duplicate normalized text
// is created when multiple search hooks consume the same store.
const normalizedPages = new WeakMap<
	SearchPage,
	{ text: string; lower: string }
>();
function normalize(page: SearchPage) {
	let cached = normalizedPages.get(page);
	if (!cached || cached.text !== page.text) {
		cached = { text: page.text, lower: page.text.toLowerCase() };
		normalizedPages.set(page, cached);
	}
	return cached.lower;
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
	const query = searchText.toLowerCase();
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
		const lower = normalize(page);
		// Ranges belong to this page. Storing every covered character wastes
		// memory and sharing offsets across pages hides legitimate matches.
		const exactStarts: number[] = [];
		let index = 0;
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
			exactCount++;
			if (maxDistance > 0) exactStarts.push(matchIndex);
			if (exactMatches.length < limit) {
				exactMatches.push({
					pageNumber: page.pageNumber,
					text: page.text.substr(matchIndex, searchText.length + textSize),
					score: 1,
					matchIndex,
					isExactMatch: true,
					searchText,
				});
			}
			index = matchIndex + searchText.length;
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
				exactStarts[exactIndex]! + searchText.length <= index
			)
				exactIndex++;
			const exactStart = exactStarts[exactIndex];
			if (exactStart !== undefined && index >= exactStart) {
				index = exactStart + searchText.length;
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
						{
							pageNumber: page.pageNumber,
							text: page.text.substr(index, query.length + textSize),
							score,
							matchIndex: index,
							isExactMatch: false,
							searchText,
						},
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
		// A real task boundary lets input, rendering and cancellation proceed.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}
