import { useCallback, useEffect } from "react";
import { usePdf } from "../../internal";
import type { VirtualItem } from "@tanstack/react-virtual";

interface UseVisiblePageProps {
  items: VirtualItem[];
}

export const useVisiblePage = ({ items }: UseVisiblePageProps) => {
  const zoomLevel = usePdf((state) => state.zoom);
  const isPinching = usePdf((state) => state.isPinching);
  const setCurrentPage = usePdf((state) => state.setCurrentPage);
  const scrollElement = usePdf((state) => state.viewportRef?.current);

  const calculateVisiblePageIndex = useCallback(
    (virtualItems: VirtualItem[]) => {
      if (!scrollElement || virtualItems.length === 0) return 0;

      const scrollTop = scrollElement.scrollTop;
      const viewportHeight = scrollElement.clientHeight;

      // Calculate visibility percentage for each item
      const visibilityScores = virtualItems.map((item) => {
        const itemTop = item.start * zoomLevel;
        const itemBottom = (item.start + item.size) * zoomLevel;

        // Calculate overlap with viewport
        const overlapTop = Math.max(scrollTop, itemTop);
        const overlapBottom = Math.min(scrollTop + viewportHeight, itemBottom);
        const overlapHeight = Math.max(0, overlapBottom - overlapTop);

        // Calculate visibility percentage and add bias towards center of viewport
        const visibilityPercentage = overlapHeight / (item.size * zoomLevel);
        const itemCenter = (itemTop + itemBottom) / 2;
        const viewportCenter = scrollTop + viewportHeight / 2;
        const distanceFromCenter = Math.abs(itemCenter - viewportCenter);
        const centerBias = 1 - distanceFromCenter / viewportHeight;

        return {
          index: item.index,
          visibility: visibilityPercentage * centerBias,
        };
      });

      // Find the item with maximum visibility
      const mostVisibleItem = visibilityScores.reduce(
        (prev, current) =>
          current.visibility > prev.visibility ? current : prev,
        { index: 0, visibility: 0 },
      );

      return mostVisibleItem.index;
    },
    [scrollElement, zoomLevel],
  );

  useEffect(() => {
    if (!isPinching && items.length > 0) {
      const mostVisibleIndex = calculateVisiblePageIndex(items);
      setCurrentPage?.(mostVisibleIndex + 1);
    }
  }, [items, isPinching, calculateVisiblePageIndex, setCurrentPage]);

  return null;
};
