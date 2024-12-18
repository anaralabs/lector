import type { PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { SearchResult } from "./useSearch";
import type { HighlightRect } from "../../internal";

interface TextPosition {
  pageNumber: number;
  text: string;
  matchIndex: number;
}

export async function calculateHighlightRects(
  pageProxy: PDFPageProxy,
  textMatch: TextPosition,
): Promise<HighlightRect[]> {
  const textContent = await pageProxy.getTextContent();
  const items = textContent.items as TextItem[];
  const matchLength = textMatch.text.length;
  const matchRects: HighlightRect[] = [];
  let currentIndex = 0;
  let remainingMatchLength = matchLength;
  let foundStart = false;

  const viewport = pageProxy.getViewport({ scale: 1 });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (!item) continue;

    const itemLength = item.str.length;

    // Check if we've found the start of our match
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
    }
    // Continue adding rectangles for subsequent parts of the match
    else if (foundStart && remainingMatchLength > 0) {
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

    // Stop if we've found all parts of the match
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
    // If rects are on the same line (approximately same y position)
    if (
      Math.abs(current.top - next.top) < 2 &&
      Math.abs(current.height - next.height) < 2
    ) {
      // Merge them
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

// Usage example with search results
export async function processSearchResults(
  result: SearchResult,
  pageProxy: PDFPageProxy,
) {
  const highlights = await calculateHighlightRects(pageProxy, {
    pageNumber: result.pageNumber,
    text: result.text,
    matchIndex: result.matchIndex,
  });

  return {
    ...result,
    highlights,
  };
}
