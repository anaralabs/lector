import { type HighlightRect, PDFStore } from "../internal";

const MERGE_THRESHOLD = 2; // Reduced threshold for more precise text following

type CollapsibleSelection = {
  highlights: HighlightRect[];
  text: string;
  isCollapsed: boolean;
};


const shouldMergeRectangles = (
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

const mergeRectangles = (
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
  const sortedRectangles = rects.toSorted((a, b) => a.top - b.top);

  let withinThresholdMergedRectangles: HighlightRect =
    sortedRectangles[0] as HighlightRect; // initialize with first rectangle to bootstrap the process
  const allMergedRectangles: HighlightRect[] = [];

  const blowUpMergedRectangles = (rect: HighlightRect): HighlightRect => {
    return {
      ...rect,
      left: rect.left - 2,
      top: rect.top - 2,
      width: rect.width + 4,
      height: rect.height + 2,
    };
  };

  for (const [index, currentRectangle] of sortedRectangles.entries()) {
    withinThresholdMergedRectangles = mergeRectangles(
      withinThresholdMergedRectangles,
      currentRectangle,
    );

    const nextRectangle = sortedRectangles[index + 1];

    // establish the last merged rectangle if there are no more rectangles to merge
    if (!nextRectangle) {
      allMergedRectangles.push(
        blowUpMergedRectangles(withinThresholdMergedRectangles),
      );
      break;
    }

    // check if the next rectangle should be merged
    if (
      !shouldMergeRectangles(withinThresholdMergedRectangles, nextRectangle)
    ) {
      // establish already merged rectangles
      allMergedRectangles.push(
        blowUpMergedRectangles(withinThresholdMergedRectangles),
      );
      // reset merged rectangles with the next unmerged rectangle in the queue
      withinThresholdMergedRectangles = nextRectangle;
    }
  }
  return allMergedRectangles;
};

export const useSelectionDimensions = () => {
  const store = PDFStore.useContext();

  const getDimension = (): CollapsibleSelection | undefined => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const highlights: HighlightRect[] = [];
    const textLayerMap = new Map<number, HighlightRect[]>();

    // Get valid client rects and filter out tiny ones
    const clientRects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 1 && rect.height > 1, // More permissive filtering for better text following
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
        height: Math.min(clientRect.height / zoom, 16), 
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
        const sortedRects = rects.sort((a, b) => {
          const yDiff = a.top - b.top;
          return yDiff === 0 ? a.left - b.left : yDiff;
        });

        const mergedRects: HighlightRect[] = [];
        const firstRect = sortedRects[0];
        if (!firstRect) return;

        let currentRect: HighlightRect = firstRect;

        for (let i = 1; i < sortedRects.length; i++) {
          const nextRect = sortedRects[i];
          if (!nextRect) continue;

          const verticalOverlap = Math.abs(nextRect.top - currentRect.top) < MERGE_THRESHOLD;
          const horizontalAdjacent = (nextRect.left - (currentRect.left + currentRect.width)) < MERGE_THRESHOLD;

          if (verticalOverlap && horizontalAdjacent) {
            currentRect = {
              pageNumber: currentRect.pageNumber,
              top: currentRect.top,
              left: currentRect.left,
              width: (nextRect.left + nextRect.width) - currentRect.left,
              height: Math.max(currentRect.height, nextRect.height),
            };
          } else {
            mergedRects.push(currentRect);
            currentRect = nextRect;
          }
        }
        mergedRects.push(currentRect);
        highlights.push(...mergedRects);
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
