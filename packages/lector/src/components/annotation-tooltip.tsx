
import { useCallback} from "react";

import type { Annotation } from "../hooks/useAnnotations";
import { useAnnotationTooltip } from "../hooks/useAnnotationTooltip";

interface AnnotationTooltipProps {
  annotation: Annotation;
  children: React.ReactNode;
  tooltipContent: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  isOpen?: boolean;
}

export const AnnotationTooltip = ({
  annotation,
  children,
  tooltipContent,
  onOpenChange,
  isOpen: controlledIsOpen,
}: AnnotationTooltipProps) => {
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