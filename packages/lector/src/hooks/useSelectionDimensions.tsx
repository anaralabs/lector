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

const consolidateRects = (rects: HighlightRect[]): HighlightRect[] => {
  if (rects.length <= 1) return rects;

  const result: HighlightRect[] = [];
  const visited = new Set<number>();

  for (let i = 0; i < rects.length; i++) {
    if (visited.has(i)) continue;
    
    const currentRect = rects[i];
    if (!currentRect) continue;
    
    let currentGroup = [currentRect];
    visited.add(i);
    
    // Find all rects that should be merged with the current one
    let foundNew = true;
    while (foundNew) {
      foundNew = false;
      for (let j = 0; j < rects.length; j++) {
        if (visited.has(j)) continue;
        
        const candidateRect = rects[j];
        if (!candidateRect) continue;
        
        // Check if this rect overlaps with any rect in the current group
        const shouldMergeWithGroup = currentGroup.some(groupRect => 
          doRectsOverlap(groupRect, candidateRect)
        );
        
        if (shouldMergeWithGroup) {
          currentGroup.push(candidateRect);
          visited.add(j);
          foundNew = true;
        }
      }
    }
    
    // Merge all rects in the current group into one
    result.push(mergeRectGroup(currentGroup));
  }

  return result;
};

const doRectsOverlap = (rect1: HighlightRect, rect2: HighlightRect): boolean => {
  // Check if rectangles overlap (not just touch)
  const horizontalOverlap = rect1.left < rect2.left + rect2.width && 
                           rect2.left < rect1.left + rect1.width;
  const verticalOverlap = rect1.top < rect2.top + rect2.height && 
                         rect2.top < rect1.top + rect1.height;
  
  // Also consider if they are very close (within threshold)
  const closeEnough = shouldMergeRects(rect1, rect2);
  
  return (horizontalOverlap && verticalOverlap) || closeEnough;
};

const mergeRectGroup = (rects: HighlightRect[]): HighlightRect => {
  if (rects.length === 1) {
    const rect = rects[0];
    if (!rect) throw new Error('Invalid rect in group');
    return rect;
  }
  
  const firstRect = rects[0];
  if (!firstRect) throw new Error('Invalid first rect in group');
  
  let minLeft = firstRect.left;
  let minTop = firstRect.top;
  let maxRight = firstRect.left + firstRect.width;
  let maxBottom = firstRect.top + firstRect.height;
  
  rects.forEach(rect => {
    if (!rect) return;
    minLeft = Math.min(minLeft, rect.left);
    minTop = Math.min(minTop, rect.top);
    maxRight = Math.max(maxRight, rect.left + rect.width);
    maxBottom = Math.max(maxBottom, rect.top + rect.height);
  });
  
  return {
    left: minLeft,
    top: minTop,
    width: maxRight - minLeft,
    height: maxBottom - minTop,
    pageNumber: firstRect.pageNumber,
  };
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
        const consolidated = consolidateRects(rects);
        highlights.push(...consolidated);
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
