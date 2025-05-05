import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useClick,
} from "@floating-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { Annotation } from "../hooks/useAnnotations";
import { useAnnotations } from "../hooks/useAnnotations";
import { usePdf } from "../internal";
import { useAnnotationTooltip } from "../hooks/useAnnotationTooltip";

interface AnnotationTooltipProps {
  annotation: Annotation;
  children: React.ReactNode;
  tooltipContent: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
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

export const AnnotationTooltip = ({
  annotation,
  children,
  tooltipContent,
  onOpenChange,
}: AnnotationTooltipProps) => {
  const {
    isOpen,
    setIsOpen,
    refs,
    floatingStyles,
    getFloatingProps,
    getReferenceProps,
  } = useAnnotationTooltip({
    annotation,
    onOpenChange,
  });

  const handleClick = useCallback(() => {
    setIsOpen(!isOpen);
  }, [isOpen, setIsOpen]);

  return (
    <>
      <div 
        ref={refs.setReference} 
        onClick={handleClick}
        {...getReferenceProps()}
      >
        {children}
      </div>
      {isOpen && (
        <div
          ref={refs.setFloating}
          className="bg-white shadow-lg rounded-lg p-3 z-50 min-w-[200px]"
          style={{
            ...floatingStyles,
            position: 'fixed',
            zIndex: 9999,
          }}
          {...getFloatingProps()}
        >
          {tooltipContent}
        </div>
      )}
    </>
  );
}; 