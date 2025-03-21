import { useCallback, useEffect } from "react";

import { useSelectionDimensions } from "../../hooks/useSelectionDimensions";
import { usePdf } from "../../internal";

export const CustomSelectionTrigger = () => {
  const setCustomSelectionRects = usePdf(
    (state) => state.setCustomSelectionRects,
  );

  const { getDimension } = useSelectionDimensions();

  const handleSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setCustomSelectionRects([]);
      return;
    }

    const rects = getDimension();
    if (!rects) {
      setCustomSelectionRects([]);
      return;
    }

    setCustomSelectionRects(rects.highlights);
  }, [getDimension, setCustomSelectionRects]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    // Handle selection changes
    document.addEventListener("selectionchange", handleSelection, { signal });

    // Handle blur events on the document
    document.addEventListener("blur", handleSelection, {
      signal,
      capture: true,
    });

    // Handle mouseup for cases where selectionchange might not fire
    document.addEventListener("mouseup", handleSelection, { signal });

    // Clean up all listeners
    return () => {
      controller.abort();
    };
  }, [handleSelection]);

  return null;
};
