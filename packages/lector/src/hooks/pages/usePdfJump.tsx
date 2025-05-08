import { type HighlightRect, usePdf } from "../../internal";

export const usePdfJump = () => {
  const virtualizer = usePdf((state) => state.virtualizer);
  const setHighlight = usePdf((state) => state.setHighlight);

  const jumpToPage = (
    pageIndex: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: "auto" | "smooth";
    },
  ) => {
    if (!virtualizer) return;

    // Define default options
    const defaultOptions = {
      align: "start",
      behavior: "smooth",
    };

    // Merge default options with any provided options

    const finalOptions = { ...defaultOptions, ...options };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    virtualizer.scrollToIndex(pageIndex - 1, finalOptions as any);
  };

  const jumpToOffset = (offset: number) => {
    if (!virtualizer) return;
    virtualizer.scrollToOffset(offset, {
      align: "start",
      behavior: "smooth",
    });
  };

  const scrollToHighlightRects = (
    rects: HighlightRect[],
    type: "pixels" | "percent",
    align: "start" | "center" = "start",
    additionalOffset: number = 0,
  ) => {
    if (!virtualizer) return;

    const firstPage = Math.min(...rects.map((rect) => rect.pageNumber));

    // Get the start offset of the page in the viewport
    const pageOffset = virtualizer.getOffsetForIndex(firstPage - 1, "start");

    if (pageOffset === null) return;

    // Find the target highlight rect (usually the first one)
    const targetRect = rects.find((rect) => rect.pageNumber === firstPage);

    if (!targetRect) return;

    const isNumber = pageOffset?.[0] != null;
    if (!isNumber) return;

    const pageStart = pageOffset[0] ?? 0;

    // Calculate the rect position and height
    let rectTop: number;
    let rectHeight: number;

    if (type === "percent") {
      const estimatePageHeight = virtualizer.options.estimateSize(
        firstPage - 1,
      );
      rectTop = (targetRect.top / 100) * estimatePageHeight;
      rectHeight = (targetRect.height / 100) * estimatePageHeight;
    } else {
      rectTop = targetRect.top;
      rectHeight = targetRect.height;
    }

    // Calculate the scroll offset based on alignment
    let scrollOffset: number;

    if (align === "center") {
      // When centering in the viewport, we need the viewport height
      const viewportHeight = virtualizer.scrollElement?.clientHeight || 0;

      // The target position is the rect's center minus half the viewport height
      // This places the rect in the center of the viewport
      const rectCenter = pageStart + rectTop + rectHeight / 2;
      scrollOffset = rectCenter - viewportHeight / 2;
    } else {
      // Use the top of the highlight rect
      scrollOffset = pageStart + rectTop;
    }

    // Apply the additional offset
    scrollOffset += additionalOffset;

    // Ensure we don't scroll to a negative offset
    const adjustedOffset = Math.max(0, scrollOffset);

    virtualizer.scrollToOffset(adjustedOffset, {
      align: "start", // Always use start when we've calculated our own centering
      behavior: "smooth",
    });
  };

  const jumpToHighlightRects = (
    rects: HighlightRect[],
    type: "pixels" | "percent",
    align: "start" | "center" = "start",
    additionalOffset: number = 0,
  ) => {
    if (!virtualizer) return;

    setHighlight(rects);
    
    scrollToHighlightRects(rects, type, align, additionalOffset);
  };

  return { jumpToPage, jumpToOffset, jumpToHighlightRects, scrollToHighlightRects};
};
