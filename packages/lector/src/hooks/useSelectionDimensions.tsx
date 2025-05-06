import { type HighlightRect, PDFStore } from "../internal";

const MERGE_THRESHOLD = 2; // Reduced threshold for more precise text following

type CollapsibleSelection = {
  highlights: HighlightRect[];
  text: string;
  isCollapsed: boolean;
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
