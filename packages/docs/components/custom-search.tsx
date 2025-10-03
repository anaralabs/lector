import {
	calculateHighlightRects,
	type SearchResult,
	usePdf,
	usePdfJump,
	useSearch,
} from "@anaralabs/lector";
import { useEffect, useState } from "react";
import { useDebounce } from "use-debounce";

// Define the TextPosition interface to match the one in useSearchPosition.tsx
interface TextPosition {
	pageNumber: number;
	text: string;
	matchIndex: number;
	searchText?: string;
}

interface ResultItemProps {
	result: SearchResult;
	originalSearchText?: string;
}

const ResultItem = ({ result, originalSearchText }: ResultItemProps) => {
	const { jumpToHighlightRects } = usePdfJump();
	const getPdfPageProxy = usePdf((state) => state.getPdfPageProxy);

	const onClick = async () => {
		const pageProxy = getPdfPageProxy(result.pageNumber);

		const textPosition: TextPosition = {
			pageNumber: result.pageNumber,
			text: result.text,
			matchIndex: result.matchIndex,
			searchText: originalSearchText,
		};

		const rects = await calculateHighlightRects(pageProxy, textPosition);

		jumpToHighlightRects(rects, "pixels");
	};

	return (
		<div
			className="flex py-2 hover:bg-gray-50 flex-col cursor-pointer"
			onClick={onClick}
		>
			<div className="flex-1 min-w-0">
				<p className="text-sm text-gray-900">{result.text}</p>
			</div>
			<div className="flex items-center gap-4 flex-shrink-0 text-sm text-gray-500">
				{!result.isExactMatch && (
					<span>{(result.score * 100).toFixed()}% match</span>
				)}
				<span className="ml-auto">Page {result.pageNumber}</span>
			</div>
		</div>
	);
};

// Component for full context highlighting
const ResultItemFullHighlight = ({ result }: { result: SearchResult }) => {
	const { jumpToHighlightRects } = usePdfJump();
	const getPdfPageProxy = usePdf((state) => state.getPdfPageProxy);

	const onClick = async () => {
		const pageProxy = getPdfPageProxy(result.pageNumber);

		const textPosition: TextPosition = {
			pageNumber: result.pageNumber,
			text: result.text,
			matchIndex: result.matchIndex,
			// No searchText parameter = highlight full context
		};

		const rects = await calculateHighlightRects(pageProxy, textPosition);
		jumpToHighlightRects(rects, "pixels");
	};

	return (
		<div
			className="flex py-2 hover:bg-gray-50 flex-col cursor-pointer"
			onClick={onClick}
		>
			<div className="flex-1 min-w-0">
				<p className="text-sm text-gray-900">{result.text}</p>
			</div>
			<div className="flex items-center gap-4 flex-shrink-0 text-sm text-gray-500">
				{!result.isExactMatch && (
					<span>{(result.score * 100).toFixed()}% match</span>
				)}
				<span className="ml-auto">Page {result.pageNumber}</span>
			</div>
		</div>
	);
};

interface ResultGroupProps {
	title: string;
	results: SearchResult[];
	displayCount?: number;
	originalSearchText?: string;
}

const ResultGroup = ({
	title,
	results,
	displayCount,
	originalSearchText,
}: ResultGroupProps) => {
	if (!results.length) return null;

	const displayResults = displayCount
		? results.slice(0, displayCount)
		: results;

	return (
		<div className="space-y-2">
			<h3 className="text-sm font-medium text-gray-700">{title}</h3>
			<div className="divide-y divide-gray-100">
				{displayResults.map((result) => (
					<ResultItem
						key={`${result.pageNumber}-${result.matchIndex}`}
						result={result}
						originalSearchText={originalSearchText}
					/>
				))}
			</div>
		</div>
	);
};

// Modified ResultGroup for full highlighting
const ResultGroupFullHighlight = ({
	title,
	results,
	displayCount,
}: Omit<ResultGroupProps, "originalSearchText">) => {
	if (!results.length) return null;

	const displayResults = displayCount
		? results.slice(0, displayCount)
		: results;

	return (
		<div className="space-y-2">
			<h3 className="text-sm font-medium text-gray-700">{title}</h3>
			<div className="divide-y divide-gray-100">
				{displayResults.map((result) => (
					<ResultItemFullHighlight
						key={`${result.pageNumber}-${result.matchIndex}`}
						result={result}
					/>
				))}
			</div>
		</div>
	);
};

export function SearchUI() {
	const [searchText, setSearchText] = useState("");
	const [debouncedSearchText] = useDebounce(searchText, 500);
	const [limit, setLimit] = useState(5); // Initial limit
	const { searchResults: results, search } = useSearch();

	useEffect(() => {
		setLimit(5);
		search(debouncedSearchText, { limit: 5 });
	}, [debouncedSearchText, search]);

	const handleSearch = (searchText: string) => {
		setSearchText(searchText);
	};

	const handleLoadMore = async () => {
		const newLimit = limit + 5;
		await search(debouncedSearchText, { limit: newLimit });
		setLimit(newLimit);
	};

	return (
		<div className="flex flex-col w-80 h-full">
			<div className="px-4 py-4 border-b border-gray-200 bg-white">
				<div className="relative">
					<input
						type="text"
						value={searchText || ""}
						onChange={(e) => handleSearch(e.target.value)}
						placeholder="Search in document..."
						className="w-full px-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto px-4">
				<div className="py-4">
					<SearchResults
						searchText={searchText}
						results={results}
						onLoadMore={handleLoadMore}
					/>
				</div>
			</div>
		</div>
	);
}

interface SearchResultsProps {
	searchText: string;
	results: {
		exactMatches: SearchResult[];
		fuzzyMatches: SearchResult[];
		hasMoreResults: boolean;
	};
	onLoadMore: () => void;
}

export const SearchResults = ({
	searchText,
	results,
	onLoadMore,
}: SearchResultsProps) => {
	if (!searchText) return null;

	if (!results.exactMatches.length && !results.fuzzyMatches.length) {
		return (
			<div className="text-center py-4 text-gray-500">No results found</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<ResultGroup
				title="Exact Matches"
				results={results.exactMatches}
				originalSearchText={searchText}
			/>
			<ResultGroup
				title="Similar Matches"
				results={results.fuzzyMatches}
				originalSearchText={searchText}
			/>

			{results.hasMoreResults && (
				<button
					onClick={onLoadMore}
					className="w-full py-2 px-4 text-sm text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
				>
					Load More Results
				</button>
			)}
		</div>
	);
};

// New component for full context highlighting
export const SearchUIFullHighlight = () => {
	const [searchText, setSearchText] = useState("");
	const [debouncedSearchText] = useDebounce(searchText, 500);
	const [limit, setLimit] = useState(5);
	const { searchResults: results, search } = useSearch();

	useEffect(() => {
		setLimit(5);
		search(debouncedSearchText, { limit: 5 });
	}, [debouncedSearchText, search]);

	const handleSearch = (searchText: string) => {
		setSearchText(searchText);
	};

	const handleLoadMore = async () => {
		const newLimit = limit + 5;
		await search(debouncedSearchText, { limit: newLimit });
		setLimit(newLimit);
	};

	return (
		<div className="flex flex-col w-80 h-full">
			<div className="px-4 py-4 border-b border-gray-200 bg-white">
				<div className="relative">
					<input
						type="text"
						value={searchText || ""}
						onChange={(e) => handleSearch(e.target.value)}
						placeholder="Search in document..."
						className="w-full px-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto px-4">
				<div className="py-4">
					<SearchResultsFullHighlight
						searchText={searchText}
						results={results}
						onLoadMore={handleLoadMore}
					/>
				</div>
			</div>
		</div>
	);
};

// Results component for full context highlighting
const SearchResultsFullHighlight = ({
	searchText,
	results,
	onLoadMore,
}: SearchResultsProps) => {
	if (!searchText) return null;

	if (!results.exactMatches.length && !results.fuzzyMatches.length) {
		return (
			<div className="text-center py-4 text-gray-500">No results found</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<ResultGroupFullHighlight
				title="Exact Matches"
				results={results.exactMatches}
			/>
			<ResultGroupFullHighlight
				title="Similar Matches"
				results={results.fuzzyMatches}
			/>

			{results.hasMoreResults && (
				<button
					onClick={onLoadMore}
					className="w-full py-2 px-4 text-sm text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
				>
					Load More Results
				</button>
			)}
		</div>
	);
};
