import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";

import { usePDFPageNumber } from "../../../hooks/usePdfPageNumber";
import { useSelectionDimensions } from "../../../hooks/useSelectionDimensions";
import { type ColoredHighlight,usePdf } from "../../../internal";
import { ColorSelectionTool } from "./color-selection-tool";
import { ColoredHighlightComponent } from "./colored-highlight";

type ColoredHighlightLayerProps = {
  onHighlight?: (highlight: ColoredHighlight) => void;
};

export const ColoredHighlightLayer = ({
  onHighlight,
}: ColoredHighlightLayerProps) => {
  const pageNumber = usePDFPageNumber();
  const { getDimension } = useSelectionDimensions();

  const highlights: ColoredHighlight[] = usePdf(
    (state) => state.coloredHighlights,
  );
  const addColoredHighlight = usePdf((state) => state.addColoredHighlight);

  const handleHighlighting = useCallback((color: string) => {
    const dimension = getDimension();
    if (!dimension) return;

    const { highlights, text } = dimension;

    if (highlights[0]) {
      const highlight: ColoredHighlight = {
        uuid: uuidv4(),
        pageNumber: highlights[0].pageNumber, // usePDFPageNumber() doesn't return the correct page number, so i'm getting the number directly from the first highlight
        color,
        rectangles: highlights,
        text,
      };
      addColoredHighlight(highlight);
      if (onHighlight) onHighlight(highlight);
    }
  }, []);

  return (
    <div className="colored-highlights-layer">
      {highlights
        .filter((selection) => selection.pageNumber === pageNumber)
        .map((selection) => (
          <ColoredHighlightComponent
            key={selection.uuid}
            selection={selection}
          />
        ))}
      <ColorSelectionTool
        onColorSelection={(colorItem) => handleHighlighting(colorItem.color)}
      />
    </div>
  );
};
