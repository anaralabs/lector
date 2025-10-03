import type { PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

import type { HighlightRect } from "../../internal";
import type { SearchResult } from "./useSearch";

interface TextPosition {
	pageNumber: number;
	text: string;
	matchIndex: number;
	searchText?: string; // Optional parameter to specify the exact search text to highlight
}

/**
 * Calculates the highlight rectangles for a given text match.
 *
 * @param pageProxy - The PDF page proxy object
 * @param textMatch - An object containing:
 *   - pageNumber: The page number where the match is found
 *   - text: The text content containing the match (usually a larger chunk of text)
 *   - matchIndex: The index within the text where the match starts
 *   - searchText: (Optional) The exact search term to highlight. If provided, only highlights
 *                 this exact term instead of the entire text. If not provided, highlights the full text.
 * @returns An array of HighlightRect objects representing the areas to highlight
 */
export async function calculateHighlightRects(
	pageProxy: PDFPageProxy,
	textMatch: TextPosition,
): Promise<HighlightRect[]> {
	const textContent = await pageProxy.getTextContent();
	const items = textContent.items as TextItem[];

	const matchLength = textMatch.searchText
		? textMatch.searchText.length
		: textMatch.text.length;

	const matchRects: HighlightRect[] = [];
	let currentIndex = 0;
	let remainingMatchLength = matchLength;
	let foundStart = false;

	const viewport = pageProxy.getViewport({ scale: 1 });

	for (let i = 0; i < items.length; i++) {
		const item = items[i];

		if (!item) continue;

		const itemLength = item.str.length;

		if (
			!foundStart &&
			currentIndex <= textMatch.matchIndex &&
			textMatch.matchIndex < currentIndex + itemLength
		) {
			foundStart = true;
			const matchStartInItem = textMatch.matchIndex - currentIndex;
			const matchLengthInItem = Math.min(
				itemLength - matchStartInItem,
				remainingMatchLength,
			);

			const transform = item.transform;
			const y = viewport.height - (transform[5] + item.height);

			const rect: HighlightRect = {
				pageNumber: textMatch.pageNumber,
				left: transform[4] + matchStartInItem * (item.width / itemLength),
				top: y,
				width: matchLengthInItem * (item.width / itemLength),
				height: item.height,
			};

			matchRects.push(rect);
			remainingMatchLength -= matchLengthInItem;
		} else if (foundStart && remainingMatchLength > 0) {
			const matchLengthInItem = Math.min(itemLength, remainingMatchLength);

			const transform = item.transform;
			const y = viewport.height - (transform[5] + item.height);

			const rect: HighlightRect = {
				pageNumber: textMatch.pageNumber,
				left: transform[4],
				top: y,
				width: matchLengthInItem * (item.width / itemLength),
				height: item.height,
			};

			matchRects.push(rect);
			remainingMatchLength -= matchLengthInItem;
		}

		if (remainingMatchLength <= 0 && foundStart) {
			break;
		}

		currentIndex += itemLength;
	}

	return mergeAdjacentRects(matchRects);
}

function mergeAdjacentRects(rects: HighlightRect[]): HighlightRect[] {
	if (rects.length <= 1) return rects;

	const merged: HighlightRect[] = [];
	let current = rects[0];

	if (!current) return rects;

	for (let i = 1; i < rects.length; i++) {
		const next = rects[i];

		if (!next) continue;
		if (
			Math.abs(current.top - next.top) < 2 &&
			Math.abs(current.height - next.height) < 2
		) {
			current = {
				...current,
				width: next.left + next.width - current.left,
			};
		} else {
			merged.push(current);
			current = next;
		}
	}
	merged.push(current);

	return merged;
}

export async function processSearchResults(
	result: SearchResult,
	pageProxy: PDFPageProxy,
	searchText?: string,
) {
	const searchTermToHighlight =
		searchText || (result as { searchText?: string }).searchText;

	const highlights = await calculateHighlightRects(pageProxy, {
		pageNumber: result.pageNumber,
		text: result.text,
		matchIndex: result.matchIndex,
		searchText: searchTermToHighlight,
	});

	return {
		...result,
		highlights,
	};
}
