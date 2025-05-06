import { useCallback} from "react";
import { createPortal } from "react-dom";

import type { Annotation } from "../hooks/useAnnotations";
import { useAnnotationTooltip } from "../hooks/useAnnotationTooltip";
import { usePdf } from "../internal";

interface AnnotationTooltipProps {
  annotation: Annotation;
  children: React.ReactNode;
  tooltipContent: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  isOpen?: boolean;
  className?: string;
}

export const AnnotationTooltip = ({
  annotation,
  children,
  tooltipContent,
  onOpenChange,
  className,
  isOpen: controlledIsOpen,
}: AnnotationTooltipProps) => {
  const viewportRef = usePdf((state) => state.viewportRef);
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

  const isOpen = controlledIsOpen ?? uncontrolledIsOpen;

  const handleClick = useCallback(() => {
    if (controlledIsOpen === undefined) {
      setIsOpen(!isOpen);
    }
  }, [controlledIsOpen, isOpen, setIsOpen]);

  return (
    <>
      <div 
        ref={refs.setReference} 
        onClick={handleClick}
        {...getReferenceProps()}
      >
        {children}
      </div>
      {isOpen && viewportRef.current && createPortal(
        <div
          ref={refs.setFloating}
          className={className}
          style={{
            ...floatingStyles,
            position: 'absolute',
            pointerEvents: 'auto',
          }}
          {...getFloatingProps()}
        >
          {tooltipContent}
        </div>,
        viewportRef.current
      )}
    </>
  );
}; 