import { useCallback, useState } from "react";

import { usePdf } from "../../internal";

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

function levenshteinDistance(a: string, b: string): number {
  // Initialize with explicit type for better inference
  const matrix = [] as number[][];

  // Initialize first row (array)
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  // Initialize first column
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j; // Use non-null assertion since we know index 0 exists
  }

  // Fill the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1,
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
}

interface SearchOptions {
  threshold?: number;
  limit?: number;
  textSize?: number;
}

export const useSearch = () => {
  const textContent = usePdf((state) => state.textContent);
  const [keywords] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResults>({
    exactMatches: [],
    fuzzyMatches: [],
    hasMoreResults: false,
  });

  const findExactMatches = (
    searchText: string,
    text: string,
    pageNumber: number,
    textSize: number,
  ): SearchResult[] => {
    const results: SearchResult[] = [];
    const textLower = text.toLowerCase();
    const searchLower = searchText.toLowerCase();
    let index = 0;

    while (true) {
      const matchIndex = textLower.indexOf(searchLower, index);
      if (matchIndex === -1) break;

      results.push({
        pageNumber,
        text: text.substr(matchIndex, searchText.length + textSize),
        score: 1,
        matchIndex,
        isExactMatch: true,
        searchText,
      });

      index = matchIndex + searchText.length;
    }

    return results;
  };

  const findFuzzyMatches = (
    searchText: string,
    text: string,
    pageNumber: number,
    threshold: number,
    excludeIndices: Set<number>,
    textSize: number,
  ): SearchResult[] => {
    const results: SearchResult[] = [];
    const textLower = text.toLowerCase();
    const searchLower = searchText.toLowerCase();
    let index = 0;

    while (index < textLower.length) {
      // Skip if this index is part of an exact match
      if (excludeIndices.has(index)) {
        index++;
        continue;
      }

      const chunk = textLower.substr(index, searchLower.length + 10);
      const distance = levenshteinDistance(
        searchLower,
        chunk.substr(0, searchLower.length),
      );
      const maxDistance = Math.floor(searchLower.length * (1 - threshold));

      if (distance <= maxDistance && distance > 0) {
        // distance > 0 ensures we don't duplicate exact matches
        const score = 1 - distance / searchLower.length;
        results.push({
          pageNumber,
          text: text.substr(index, searchLower.length + textSize),
          score,
          matchIndex: index,
          isExactMatch: false,
          searchText,
        });
        index += searchLower.length;
      } else {
        index++;
      }
    }

    return results;
  };

  const search = useCallback(
    (searchText: string, options: SearchOptions = {}): SearchResults => {
      const { threshold = 0.7, limit = 10, textSize = 100 } = options;

      if (!searchText.trim()) {
        const emptyResults = {
          exactMatches: [],
          fuzzyMatches: [],
          hasMoreResults: false,
        };
        setSearchResults(emptyResults);
        return emptyResults;
      }

      let exactMatches: SearchResult[] = [];
      let fuzzyMatches: SearchResult[] = [];
      const exactMatchIndices = new Set<number>();

      // First, find all exact matches
      textContent.forEach(({ pageNumber, text }) => {
        const matches = findExactMatches(
          searchText,
          text,
          pageNumber,
          textSize,
        );
        exactMatches = [...exactMatches, ...matches];

        // Record the indices of exact matches to avoid fuzzy matching these
        matches.forEach((match) => {
          for (let i = 0; i < searchText.length; i++) {
            exactMatchIndices.add(match.matchIndex + i);
          }
        });
      });

      // Then find fuzzy matches, excluding exact match locations
      textContent.forEach(({ pageNumber, text }) => {
        const matches = findFuzzyMatches(
          searchText,
          text,
          pageNumber,
          threshold,
          exactMatchIndices,
          textSize,
        );
        fuzzyMatches = [...fuzzyMatches, ...matches];
      });

      // Sort both sets of results by score
      exactMatches.sort((a, b) => b.score - a.score);
      fuzzyMatches.sort((a, b) => b.score - a.score);

      // Apply limits while maintaining ratio
      const exactLimit = Math.min(exactMatches.length, Math.ceil(limit / 2));
      const fuzzyLimit = Math.min(fuzzyMatches.length, limit - exactLimit);

      const limitedResults = {
        exactMatches: exactMatches.slice(0, exactLimit),
        fuzzyMatches: fuzzyMatches.slice(0, fuzzyLimit),
        hasMoreResults: exactMatches.length + fuzzyMatches.length > limit,
      };

      setSearchResults(limitedResults);
      return limitedResults;
    },
    [textContent],
  );

  return {
    textContent,
    keywords,
    searchResults,
    search,
  };
};
