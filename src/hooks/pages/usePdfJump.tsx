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

  const jumpToHighlightRects = (
    rects: HighlightRect[],
    type: "pixels" | "percent",
  ) => {
    if (!virtualizer) return;

    setHighlight(rects);
    const firstPage = Math.min(...rects.map((rect) => rect.pageNumber));

    // Get the start offset of the page in the viewport
    const pageOffset = virtualizer.getOffsetForIndex(firstPage - 1, "start");

    if (pageOffset === null) return;

    // Find the target highlight rect (usually the first one)
    const targetRect = rects.find((rect) => rect.pageNumber === firstPage);

    if (!targetRect) return;
    // Calculate absolute scroll position:
    // Page offset + highlight's position within the page
    const isNumber = pageOffset?.[0] != null;

    if (!isNumber) return;

    let scrollOffset: number;

    if (type === "percent") {
      // Get the page dimensions
      const estimatePageHeight = virtualizer.options.estimateSize(
        firstPage - 1,
      );

      // Convert percentage to pixels based on page height
      const topInPixels = (targetRect.top / 100) * estimatePageHeight;
      scrollOffset = (pageOffset[0] ?? 0) + topInPixels;
    } else {
      // Original pixel-based calculation
      scrollOffset = (pageOffset[0] ?? 0) + targetRect.top;
    }

    // Adjust for padding
    const adjustedOffset = Math.max(0, scrollOffset);

    virtualizer.scrollToOffset(adjustedOffset, {
      align: "start",
      behavior: "smooth",
    });
  };

  return { jumpToPage, jumpToOffset, jumpToHighlightRects };
};
