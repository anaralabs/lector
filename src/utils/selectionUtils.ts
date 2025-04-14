import type { ColoredHighlight, HighlightRect } from "../internal";

export const getEndOfHighlight = (selection: ColoredHighlight) => {
  const lastRectangle = selection.rectangles[
    selection.rectangles.length - 1
  ] as HighlightRect;
  return lastRectangle.left + lastRectangle.width + 10;
};

export const getMidHeightOfHighlightLine = (selection: ColoredHighlight) => {
  const lastRectangle = selection.rectangles[
    selection.rectangles.length - 1
  ] as HighlightRect;
  return lastRectangle.top + lastRectangle.height / 2;
};
