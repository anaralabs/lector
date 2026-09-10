import { useCallback, useState } from "react";
import { usePdf } from "../../internal";
import { type SearchOptions, searchDocument } from "../../lib/search";

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
	const [keywords] = useState<string[]>([]);
	const [searchResults, setSearchResults] = useState<SearchResults>({
		exactMatches: [],
		fuzzyMatches: [],
		hasMoreResults: false,
	});
	const search = useCallback(
		(searchText: string, options: SearchOptions = {}): SearchResults => {
			const results = searchDocument(textContent, searchText, options);
			setSearchResults(results);
			return results;
		},
		[textContent],
	);
	return { textContent, keywords, searchResults, search };
};
