import type { Annotation } from "../../hooks/useAnnotations";
import { useAnnotations } from "../../hooks/useAnnotations";
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { AnnotationTooltip } from "../annotation-tooltip";

interface AnnotationHighlightLayerProps {
  className?: string;
  style?: React.CSSProperties;
  renderTooltipContent: (props: {
    annotation: Annotation;
    onClose: () => void;
  }) => React.ReactNode;
  focusedAnnotationId?: string;
  onAnnotationClick?: (annotation: Annotation) => void;
}

export const AnnotationHighlightLayer = ({
  className,
  style,
  renderTooltipContent,
  focusedAnnotationId,
  onAnnotationClick,
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
          isOpen={focusedAnnotationId === annotation.id}
          onOpenChange={(open) => {
            if (open && onAnnotationClick) {
              onAnnotationClick(annotation);
            }
          }}
          tooltipContent={(
              renderTooltipContent({
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
                style={{
                  position: "absolute",
                  top: highlight.top,
                  left: highlight.left,
                  width: highlight.width,
                  height: highlight.height,
                  backgroundColor: annotation.color || "rgba(255, 255, 0, 0.3)",
                  mixBlendMode: "multiply",
                  borderRadius: "2px",
                  transition: "all 0.2s ease",
                  cursor: "pointer",
                  opacity: focusedAnnotationId === annotation.id ? 1 : 0.9,
                  lineHeight: `${highlight.height}px`,
                  pointerEvents: "all",
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