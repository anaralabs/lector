import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from "@floating-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { Annotation } from "./useAnnotations";
import { usePdf } from "../internal";

interface UseAnnotationTooltipProps {
  annotation: Annotation;
  onOpenChange?: (open: boolean) => void;
}

interface UseAnnotationTooltipReturn {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  refs: ReturnType<typeof useFloating>["refs"];
  floatingStyles: ReturnType<typeof useFloating>["floatingStyles"];
  getFloatingProps: ReturnType<typeof useInteractions>["getFloatingProps"];
  getReferenceProps: ReturnType<typeof useInteractions>["getReferenceProps"];
}

const defaultRect = {
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

export const useAnnotationTooltip = ({
  annotation,
  onOpenChange,
}: UseAnnotationTooltipProps): UseAnnotationTooltipReturn => {
  // Show tooltip immediately if it's a new annotation
  const isNewAnnotation = Date.now() - new Date(annotation.createdAt).getTime() < 1000;
  const [isOpen, setIsOpen] = useState(isNewAnnotation);
  const viewportRef = usePdf((state) => state.viewportRef);

  const {
    refs,
    floatingStyles,
    context,
  } = useFloating({
    placement: "top",
    open: isOpen,
    onOpenChange: (open) => {
      setIsOpen(open);
      onOpenChange?.(open);
    },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(10),
      flip({
        crossAxis: false,
      }),
      shift({ padding: 8 }),
    ],
  });

  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  const updateTooltipPosition = useCallback(() => {
    if (!annotation.highlights.length) return;

    // Get the last highlight rect to position the tooltip
    const lastHighlight = annotation.highlights[annotation.highlights.length - 1];
    
    refs.setReference({
      getBoundingClientRect: () => {
        const viewportElement = viewportRef.current;
        if (!viewportElement || !lastHighlight) return defaultRect;

        const pageElement = viewportElement.querySelector(`[data-page-number="${annotation.pageNumber}"]`);
        if (!pageElement) return defaultRect;

        const pageRect = pageElement.getBoundingClientRect();
        
        // Calculate client coordinates relative to the viewport
        const left = pageRect.left + lastHighlight.left;
        const top = pageRect.top + lastHighlight.top;
        const width = lastHighlight.width;
        const height = lastHighlight.height;

        return {
          width,
          height,
          x: left,
          y: top,
          top,
          right: left + width,
          bottom: top + height,
          left,
        };
      },
    });
  }, [annotation.highlights, annotation.pageNumber, refs, viewportRef]);

  useEffect(() => {
    updateTooltipPosition();

    const handleScroll = () => {
      requestAnimationFrame(updateTooltipPosition);
    };

    const handleResize = () => {
      requestAnimationFrame(updateTooltipPosition);
    };

    if (viewportRef.current) {
      viewportRef.current.addEventListener("scroll", handleScroll, {
        passive: true,
      });
    }

    window.addEventListener("resize", handleResize, { passive: true });

    return () => {
      if (viewportRef.current) {
        viewportRef.current.removeEventListener("scroll", handleScroll);
      }
      window.removeEventListener("resize", handleResize);
    };
  }, [updateTooltipPosition, viewportRef]);

  return {
    isOpen,
    setIsOpen,
    refs,
    floatingStyles,
    getFloatingProps,
    getReferenceProps,
  };
}; 