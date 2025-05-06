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

import { usePdf } from "../internal";
import type { Annotation } from "../internal";

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
  const [isOpen, setIsOpen] = useState(false);
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
    refs.setReference({
      getBoundingClientRect: () => {
        const viewportElement = viewportRef.current;
        if (!viewportElement) return defaultRect;

        const pageElement = viewportElement.querySelector(`[data-page-number="${annotation.pageNumber}"]`);
        if (!pageElement) return defaultRect;

        const pageRect = pageElement.getBoundingClientRect();

        // Calculate client coordinates relative to the viewport
        const left = pageRect.left + (annotation.highlights[0]?.left || 0);
        const top = pageRect.top + (annotation.highlights[0]?.top || 0);
        const width = annotation.highlights[0]?.width || 0;
        const height = annotation.highlights[0]?.height || 0;

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
    const viewport = viewportRef.current;
    updateTooltipPosition();

    const handleScroll = () => {
      requestAnimationFrame(updateTooltipPosition);
    };

    const handleResize = () => {
      requestAnimationFrame(updateTooltipPosition);
    };

    if (viewport) {
      viewport.addEventListener("scroll", handleScroll, {
        passive: true,
      });
    }

    window.addEventListener("resize", handleResize, { passive: true });

    return () => {
      if (viewport) {
        viewport.removeEventListener("scroll", handleScroll);
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