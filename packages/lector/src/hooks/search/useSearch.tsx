import { useCallback, useEffect, useRef, useState } from "react";
import { usePdf } from "../../internal";
import {
	type AsyncSearchOptions,
	type SearchOptions,
	searchDocument,
	searchDocumentAsync,
} from "../../lib/search";

export interface SearchResult {
	pageNumber: number;
	text: string;
	score: number;
	matchIndex: number;
	isExactMatch: boolean;
	searchText?: string;
}

export interface SearchResults {
	exactMatches: SearchResult[];
	fuzzyMatches: SearchResult[];
	hasMoreResults: boolean;
}

export const useSearch = () => {
	const textContent = usePdf((state) => state.textContent);
	const activeSearch = useRef<AbortController | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const [keywords] = useState<string[]>([]);
	const [searchResults, setSearchResults] = useState<SearchResults>({
		exactMatches: [],
		fuzzyMatches: [],
		hasMoreResults: false,
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: replacing document text invalidates pending work
	useEffect(() => {
		setIsSearching(false);
		return () => {
			activeSearch.current?.abort();
			activeSearch.current = null;
		};
	}, [textContent]);
	const cancelSearch = useCallback(() => {
		activeSearch.current?.abort();
		activeSearch.current = null;
		setIsSearching(false);
	}, []);
	const searchAsync = useCallback(
		async (
			searchText: string,
			options: AsyncSearchOptions = {},
		): Promise<SearchResults> => {
			activeSearch.current?.abort();
			const controller = new AbortController();
			activeSearch.current = controller;
			const abort = () => controller.abort();
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			setIsSearching(true);
			try {
				const results = await searchDocumentAsync(textContent, searchText, {
					...options,
					signal: controller.signal,
				});
				if (controller.signal.aborted)
					throw new DOMException("Search aborted", "AbortError");
				if (activeSearch.current === controller) setSearchResults(results);
				return results;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				if (activeSearch.current === controller) {
					activeSearch.current = null;
					setIsSearching(false);
				}
			}
		},
		[textContent],
	);
	const search = useCallback(
		(searchText: string, options: SearchOptions = {}): SearchResults => {
			cancelSearch();
			const results = searchDocument(textContent, searchText, options);
			setSearchResults(results);
			return results;
		},
		[textContent, cancelSearch],
	);
	return {
		textContent,
		keywords,
		searchResults,
		search,
		searchAsync,
		cancelSearch,
		isSearching,
	};
};
