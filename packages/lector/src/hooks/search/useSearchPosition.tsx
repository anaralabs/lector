import type { PDFPageProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";

import type { HighlightRect } from "../../internal";
import type { SearchResult } from "./useSearch";

interface TextPosition {
	pageNumber: number;
	text: string;
	matchIndex: number;
	matchLength?: number;
	searchText?: string; // Optional parameter to specify the exact search text to highlight
}

export async function calculateHighlightRects(
	pageProxy: PDFPageProxy,
	textMatch: TextPosition,
): Promise<HighlightRect[]> {
	const matchLength =
		textMatch.matchLength ??
		(textMatch.searchText
			? textMatch.searchText.length
			: textMatch.text.length);
	if (
		!Number.isFinite(matchLength) ||
		matchLength <= 0 ||
		!Number.isFinite(textMatch.matchIndex) ||
		textMatch.matchIndex < 0
	)
		return [];
	const matchEnd = textMatch.matchIndex + matchLength;
	const reader: ReadableStreamDefaultReader<TextContent> = pageProxy
		.streamTextContent()
		.getReader();
	const matchRects: HighlightRect[] = [];
	const viewport = pageProxy.getViewport({ scale: 1 });
	let offset = 0;
	let foundEnd = false;
	try {
		read: while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			for (const item of value.items) {
				if (!("str" in item) || item.str.length === 0) continue;
				const length = item.str.length;
				const start = Math.max(0, textMatch.matchIndex - offset);
				const end = Math.min(length, matchEnd - offset);
				if (end > start) {
					matchRects.push({
						pageNumber: textMatch.pageNumber,
						left: item.transform[4] + start * (item.width / length),
						top: viewport.height - (item.transform[5] + item.height),
						width: (end - start) * (item.width / length),
						height: item.height,
					});
				}
				offset += length;
				if (offset >= matchEnd) {
					foundEnd = true;
					break read;
				}
			}
		}
	} finally {
		// Each call owns an independent stream. Cancel only its remaining
		// work, leaving other searches and the selectable text layer alone.
		// PDF.js closes locally immediately; its worker acknowledgement can wait
		// on extraction, so do not block delivering an already-complete match.
		if (foundEnd)
			void reader.cancel(new Error("Highlight range found")).catch(() => {});
		reader.releaseLock();
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
		matchLength: result.matchLength,
		searchText: searchTermToHighlight,
	});

	return {
		...result,
		highlights,
	};
}
