import { type HighlightRect, PDFStore } from "../internal";

const MERGE_THRESHOLD = 5; // Increased threshold for more aggressive merging

type CollapsibleSelection = {
  highlights: HighlightRect[];
  text: string;
  isCollapsed: boolean;
};

const shouldMergeRects = (
  rect1: HighlightRect,
  rect2: HighlightRect,
): boolean => {
  // Consider vertical overlap
  const verticalOverlap = !(
    rect1.top > rect2.top + rect2.height || rect2.top > rect1.top + rect1.height
  );

  // Consider horizontal proximity more liberally
  const horizontallyClose =
    Math.abs(rect1.left + rect1.width - rect2.left) < MERGE_THRESHOLD ||
    Math.abs(rect2.left + rect2.width - rect1.left) < MERGE_THRESHOLD ||
    (rect1.left < rect2.left + rect2.width &&
      rect2.left < rect1.left + rect1.width); // Overlap check

  return verticalOverlap && horizontallyClose;
};

const mergeRects = (
  rect1: HighlightRect,
  rect2: HighlightRect,
): HighlightRect => {
  return {
    left: Math.min(rect1.left, rect2.left),
    top: Math.min(rect1.top, rect2.top),
    width:
      Math.max(rect1.left + rect1.width, rect2.left + rect2.width) -
      Math.min(rect1.left, rect2.left),
    height:
      Math.max(rect1.top + rect1.height, rect2.top + rect2.height) -
      Math.min(rect1.top, rect2.top),
    pageNumber: rect1.pageNumber,
  };
};

const consolidateRects = (rects: HighlightRect[]): HighlightRect[] => {
  if (rects.length <= 1) return rects;

  // Sort by vertical position primarily
  const sortedRects = [...rects].sort((a, b) => a.top - b.top);

  // Keep merging until no more merges are possible
  let hasChanges: boolean;
  do {
    hasChanges = false;
    let currentRect = sortedRects[0];
    const tempResult: HighlightRect[] = [];

    for (let i = 1; i < sortedRects.length; i++) {
      const sorted = sortedRects[i];
      if (!currentRect || !sorted) continue;

      if (shouldMergeRects(currentRect, sorted)) {
        currentRect = mergeRects(currentRect, sorted);
        hasChanges = true;
      } else {
        tempResult.push(currentRect);
        currentRect = sorted;
      }
    }
    if (currentRect) tempResult.push(currentRect);

    sortedRects.length = 0;
    sortedRects.push(...tempResult);
  } while (hasChanges);

  return sortedRects;
};

export const useSelectionDimensions = () => {
  const store = PDFStore.useContext();

  const getDimension = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const highlights: HighlightRect[] = [];
    const textLayerMap = new Map<number, HighlightRect[]>();

    // Get valid client rects and filter out tiny ones
    const clientRects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 2 && rect.height > 2,
    );

    clientRects.forEach((clientRect) => {
      const element = document.elementFromPoint(
        clientRect.left + 1,
        clientRect.top + clientRect.height / 2,
      );

      const textLayer = element?.closest(".textLayer");
      if (!textLayer) return;

      const pageNumber = parseInt(
        textLayer.getAttribute("data-page-number") || "1",
        10,
      );
      const textLayerRect = textLayer.getBoundingClientRect();
      const zoom = store.getState().zoom;

      const rect: HighlightRect = {
        width: clientRect.width / zoom,
        height: clientRect.height / zoom,
        top: (clientRect.top - textLayerRect.top) / zoom,
        left: (clientRect.left - textLayerRect.left) / zoom,
        pageNumber,
      };

      if (!textLayerMap.has(pageNumber)) {
        textLayerMap.set(pageNumber, []);
      }
      textLayerMap.get(pageNumber)?.push(rect);
    });

    textLayerMap.forEach((rects) => {
      if (rects.length > 0) {
        highlights.push(...consolidateRects(rects));
      }
    });

    return {
      highlights: highlights.sort((a, b) => a.pageNumber - b.pageNumber),
      text: range.toString().trim(),
      isCollapsed: false,
    };
  };
  const getSelection = (): CollapsibleSelection => getDimension() as CollapsibleSelection;

  return { getDimension, getSelection };

};
