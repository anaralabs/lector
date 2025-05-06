import { useEffect } from "react";
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { AnnotationTooltip } from "../annotation-tooltip";
import { useAnnotationLayer } from "../../hooks/layers/useAnnotationLayer";
import { usePdf } from "../../internal";
import type { Annotation } from "../../internal";

interface AnnotationHighlightLayerProps {
  className?: string;
  style?: React.CSSProperties;
  renderTooltipContent: (props: {
    annotation: Annotation;
    onClose: () => void;
  }) => React.ReactNode;
  focusedAnnotationId?: string;
  onAnnotationClick?: (annotation: Annotation | null) => void;
}

export const AnnotationHighlightLayer = ({
  className,
  style,
  renderTooltipContent,
  focusedAnnotationId,
  onAnnotationClick,
}: AnnotationHighlightLayerProps) => {
  const pageNumber = usePDFPageNumber();
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  const annotations = usePdf((state) => state.annotations);
  const setAnnotations = usePdf((state) => state.setAnnotations);

  // Setup PDF.js annotation layer
  const { annotationLayerRef } = useAnnotationLayer({
    renderForms: true,
    externalLinksEnabled: true,
  });

  // Load PDF annotations when page changes
  useEffect(() => {
    if (!pdfPageProxy) return;

    const loadAnnotations = async () => {
      try {
        const pdfAnnotations = await pdfPageProxy.getAnnotations();
        const processedAnnotations = pdfAnnotations.map((ann: any) => ({
          id: ann.id || Math.random().toString(36).substring(7),
          pageNumber,
          highlights: ann.highlights,
          color: ann.color,
          comment: ann.comment,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Annotation));
        
        // Add each annotation to the store
        setAnnotations(processedAnnotations);
      } catch (error) {
        console.error('Error loading PDF annotations:', error);
      }
    };

    void loadAnnotations();
  }, [pdfPageProxy, pageNumber]);

  // Filter annotations for current page
  const pageAnnotations = annotations.filter(
    (annotation) => annotation.pageNumber === pageNumber
  );

  return (
    <>
      {/* Native PDF.js annotation layer */}
      <div ref={annotationLayerRef} className="annotationLayer" />

      {/* Custom highlight annotations */}
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
            tooltipContent={
              renderTooltipContent({
                annotation,
                onClose: () => {},
              })
            }
          >
            <div 
              style={{ cursor: "pointer" }}
              onClick={() => onAnnotationClick?.(annotation)}
            >
              {annotation.highlights?.map((highlight, index) => (
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
                  transition: "all 0.2s ease",
                  cursor: "pointer",
                }}
                data-highlight-id={annotation.id}
              />
            ))}
            </div>
          </AnnotationTooltip>
        ))}
      </div>
    </>
  );
}; 