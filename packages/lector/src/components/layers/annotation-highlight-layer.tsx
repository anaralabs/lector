import type { Annotation } from "../../hooks/useAnnotations";
import { useAnnotations } from "../../hooks/useAnnotations";
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { AnnotationTooltip, type AnnotationTooltipContentProps } from "../annotation-tooltip";


interface AnnotationHighlightLayerProps {
  className?: string;
  style?: React.CSSProperties;
  renderTooltipContent: (props: AnnotationTooltipContentProps) => React.ReactNode;
  renderHoverTooltipContent: (props: {
    annotation: Annotation;
    onClose: () => void;
  }) => React.ReactNode;
  focusedAnnotationId?: string;
  focusedHoverAnnotationId?: string;
  onAnnotationClick?: (annotation: Annotation) => void;
  tooltipClassName?: string;
  hoverTooltipClassName?: string;
  highlightClassName?: string;
  tooltipBubbleSize?: number;
}

export const AnnotationHighlightLayer = ({
  className,
  style,
  renderTooltipContent,
  renderHoverTooltipContent,
  tooltipClassName,
  highlightClassName,
  focusedAnnotationId,
  focusedHoverAnnotationId,
  onAnnotationClick,
  hoverTooltipClassName,
  tooltipBubbleSize = 6,
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
          className={tooltipClassName}
          hoverClassName={hoverTooltipClassName}
          isOpen={focusedAnnotationId === annotation.id}
          tooltipBubbleSize={tooltipBubbleSize}
          hoverIsOpen={focusedHoverAnnotationId === annotation.id}
          onOpenChange={(open) => {
            if (open && onAnnotationClick) {
              onAnnotationClick(annotation);
            }
          }}
          renderTooltipContent={
              renderTooltipContent
          }
          hoverTooltipContent={(
            renderHoverTooltipContent({
                annotation,
                onClose: () => {},
              })
            ) 
          }
        >
          <div 
            style={{ cursor: "pointer" }}
            onClick={() => onAnnotationClick?.(annotation)}
          >
            {annotation.highlights.map((highlight, index) => (
              <div
                key={index}
                className={highlightClassName}
                style={{
                  position: "absolute",
                  top: highlight.top,
                  left: highlight.left,
                  width: highlight.width,
                  height: highlight.height,
                  backgroundColor: annotation.color,
                }}
                data-highlight-id={annotation.id}
              />
            ))}
          </div>
        </AnnotationTooltip>
      ))}
    </div>
  );
}; 