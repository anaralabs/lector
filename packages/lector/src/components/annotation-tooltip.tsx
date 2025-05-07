import { useCallback, useRef } from "react";
import { createPortal } from "react-dom";

import type { Annotation } from "../hooks/useAnnotations";
import { useAnnotationTooltip } from "../hooks/useAnnotationTooltip";
import { usePdf } from "../internal";

interface AnnotationTooltipProps {
  annotation: Annotation;
  children: React.ReactNode;
  tooltipContent: React.ReactNode;
  hoverTooltipContent?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  isOpen?: boolean;
  className?: string;
  hoverClassName?: string;
  renderHoverTooltipContent?: (props: {
    annotation: Annotation;
    onClose: () => void;
  }) => React.ReactNode;
}

export const AnnotationTooltip = ({
  annotation,
  children,
  tooltipContent,
  hoverTooltipContent,
  onOpenChange,
  className,
  hoverClassName,
  isOpen: controlledIsOpen,
}: AnnotationTooltipProps) => {
  const viewportRef = usePdf((state) => state.viewportRef);
  const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMouseInTooltipRef = useRef(false);
  
  const {
    isOpen: uncontrolledIsOpen,
    setIsOpen,
    refs,
    floatingStyles,
    getFloatingProps,
    getReferenceProps,
  } = useAnnotationTooltip({
    annotation,
    onOpenChange,
  });

  const {
    isOpen: hoverIsOpen,
    setIsOpen: setHoverIsOpen,
    refs: hoverRefs,
    floatingStyles: hoverFloatingStyles,
    getFloatingProps: getHoverFloatingProps,
    getReferenceProps: getHoverReferenceProps,
  } = useAnnotationTooltip({
    annotation,
  });

  const isOpen = controlledIsOpen ?? uncontrolledIsOpen;

  const handleClick = useCallback(() => {
    if (controlledIsOpen === undefined) {
      setIsOpen(!isOpen);
    }
  }, [controlledIsOpen, isOpen, setIsOpen]);

  const handleMouseEnter = useCallback(() => {
    if (hoverTooltipContent) {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      setHoverIsOpen(true);
    }
  }, [hoverTooltipContent, setHoverIsOpen]);

  const closeTooltip = useCallback(() => {
    if (!isMouseInTooltipRef.current) {
      setHoverIsOpen(false);
    }
  }, [setHoverIsOpen]);

  const handleMouseLeave = useCallback(() => {
    if (!hoverTooltipContent) return;
    
    // Set a timeout to close the tooltip, giving time to move to it
    closeTimeoutRef.current = setTimeout(closeTooltip, 100);
  }, [hoverTooltipContent, closeTooltip]);

  const handleTooltipMouseEnter = useCallback(() => {
    isMouseInTooltipRef.current = true;
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const handleTooltipMouseLeave = useCallback(() => {
    isMouseInTooltipRef.current = false;
    setHoverIsOpen(false);
  }, [setHoverIsOpen]);

  return (
    <>
      <div 
        ref={(node) => {
          refs.setReference(node);
          hoverRefs.setReference(node);
        }}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...getReferenceProps()}
        {...getHoverReferenceProps()}
      >
        {children}
      </div>
      {/* Click tooltip */}
      {isOpen && viewportRef.current && createPortal(
        <div
          ref={refs.setFloating}
          className={className}
          data-annotation-tooltip="click"
          style={{
            ...floatingStyles,
            position: 'absolute',
            pointerEvents: 'auto',
            zIndex: 50,
          }}
          {...getFloatingProps()}
        >
          {tooltipContent}
        </div>,
        viewportRef.current
      )}
      {/* Hover tooltip */}
      {!isOpen && hoverIsOpen && annotation.comment && hoverTooltipContent && viewportRef.current && createPortal(
        <div
          ref={hoverRefs.setFloating}
          className={hoverClassName}
          data-annotation-tooltip="hover"
          style={{
            ...hoverFloatingStyles,
            position: 'absolute',
            pointerEvents: 'auto',
            zIndex: 51,
          }}
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
          {...getHoverFloatingProps()}
        >
          {hoverTooltipContent}
        </div>,
        viewportRef.current
      )}
    </>
  );
}; 