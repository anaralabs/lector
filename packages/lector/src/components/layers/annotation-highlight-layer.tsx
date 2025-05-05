import { useCallback } from "react";
import { useSelectionDimensions } from "../../hooks/useSelectionDimensions";
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { useAnnotations } from "../../hooks/useAnnotations";
import type { Annotation } from "../../hooks/useAnnotations";
import { SelectionTooltip } from "../selection-tooltip";
import { AnnotationTooltip } from "../annotation-tooltip";
import { DefaultAnnotationTooltipContent } from "../default-annotation-tooltip";
import { usePdf } from "../../internal";

interface AnnotationHighlightLayerProps {
  className?: string;
  style?: React.CSSProperties;
  renderTooltipContent?: (props: {
    annotation: Annotation;
    onClose: () => void;
  }) => React.ReactNode;
}

export const AnnotationHighlightLayer = ({
  className,
  style,
  renderTooltipContent,
}: AnnotationHighlightLayerProps) => {
  const { annotations } = useAnnotations();
  const pageNumber = usePDFPageNumber();

  const pageAnnotations = annotations.filter(
    (annotation) => annotation.pageNumber === pageNumber
  );

  return (
    <div className={className} style={style}>
      {pageAnnotations.map((annotation) => (
        <AnnotationTooltip
          key={annotation.id}
          annotation={annotation}
          tooltipContent={
            renderTooltipContent ? (
              renderTooltipContent({
                annotation,
                onClose: () => {},
              })
            ) : (
              <DefaultAnnotationTooltipContent
                annotation={annotation}
                onClose={() => {}}
              />
            )
          }
        >
          <div style={{ cursor: "pointer" }}>
            {annotation.highlights.map((highlight, index) => (
              <div
                key={index}
                style={{
                  position: "absolute",
                  top: highlight.top,
                  left: highlight.left,
                  width: highlight.width,
                  height: highlight.height,
                  backgroundColor: annotation.color || "rgba(255, 255, 0, 0.3)",
                  transition: "background-color 0.2s ease",
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </AnnotationTooltip>
      ))}
    </div>
  );
}; 