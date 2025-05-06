import { Slot } from "@radix-ui/react-slot";
import type { ElementRef, ReactNode } from "react";
import { forwardRef } from "react";

import { useAnnotationTooltip } from "../hooks/useAnnotationTooltip";
import type { Annotation } from "../internal";

interface AnnotationTooltipProps {
  annotation: Annotation;
  tooltipContent: ReactNode;
  children: ReactNode;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  asChild?: boolean;
}

export const AnnotationTooltip = forwardRef<
  ElementRef<"div">,
  AnnotationTooltipProps
>(({ annotation, tooltipContent, children, isOpen, onOpenChange, asChild, ...props }, ref) => {
  const { getReferenceProps, getFloatingProps, refs, floatingStyles } = useAnnotationTooltip({
    annotation,
    onOpenChange,
  });

  const Comp = asChild ? Slot : "div";

  return (
    <>
      <Comp ref={refs.setReference} {...getReferenceProps()} {...props}>
        {children}
      </Comp>
      {isOpen && (
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps()}
          className="z-50"
        >
          {tooltipContent}
        </div>
      )}
    </>
  );
}); 