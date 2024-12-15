import { useSelectionDimensions } from "@/hooks/useSelectionDimensions";
import { usePDF } from "@/lib/internal";
import React, { useEffect, useCallback } from "react";

export const CustomSelectionTrigger = () => {
  const setCustomSelectionRects = usePDF(
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
    // Handle selection changes
    document.addEventListener("selectionchange", handleSelection);

    // Handle blur events on the document
    document.addEventListener("blur", handleSelection, true);

    // Handle mouseup for cases where selectionchange might not fire
    document.addEventListener("mouseup", handleSelection);

    // Clean up all listeners
    return () => {
      document.removeEventListener("selectionchange", handleSelection);
      document.removeEventListener("blur", handleSelection, true);
      document.removeEventListener("mouseup", handleSelection);
    };
  }, [handleSelection]);

  return null;
};
