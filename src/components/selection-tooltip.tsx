import React, { useState, useEffect, useRef } from "react";
import {
  useFloating,
  useDismiss,
  useInteractions,
  autoUpdate,
} from "@floating-ui/react";
import { usePdf } from "../internal";

interface SelectionTooltipProps {
  children: React.ReactNode;
}

export const SelectionTooltip = ({ children }: SelectionTooltipProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const lastSelectionRef = useRef<Range | null>(null);
  const viewportRef = usePdf((state) => state.viewportRef);

  const { refs, floatingStyles, context } = useFloating({
    placement: "bottom",
    open: isOpen,
    onOpenChange: setIsOpen,
    whileElementsMounted: autoUpdate,
  });

  const dismiss = useDismiss(context);
  const { getFloatingProps } = useInteractions([dismiss]);

  // Function to update tooltip position based on selection
  const updateTooltipPosition = () => {
    const selection = document.getSelection();

    if (!selection || selection.isCollapsed) {
      setIsOpen(false);
      lastSelectionRef.current = null;
      return;
    }

    const range = selection.getRangeAt(0);
    if (!range) return;

    lastSelectionRef.current = range;
    refs.setReference({
      getBoundingClientRect: () => range.getBoundingClientRect(),
      getClientRects: () => range.getClientRects(),
    });
    setIsOpen(true);
  };

  useEffect(() => {
    const handleSelectionChange = () => {
      // Use requestAnimationFrame to avoid rapid updates
      requestAnimationFrame(updateTooltipPosition);
    };

    // Handle scroll events in the viewport
    const handleScroll = () => {
      if (!isOpen || !lastSelectionRef.current) return;
      requestAnimationFrame(updateTooltipPosition);
    };

    // Add selection change listener
    document.addEventListener("selectionchange", handleSelectionChange);

    // Add scroll listener to viewport if it exists
    if (viewportRef.current) {
      viewportRef.current.addEventListener("scroll", handleScroll, {
        passive: true,
      });
    }

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (viewportRef.current) {
        viewportRef.current.removeEventListener("scroll", handleScroll);
      }
    };
  }, [refs, isOpen, viewportRef]);

  // Handle clicks on the floating tooltip
  useEffect(() => {
    const handleFloatingClick = (e: MouseEvent) => {
      if (refs.floating.current?.contains(e.target as Node)) {
        e.stopPropagation();
      }
    };

    document.addEventListener("click", handleFloatingClick);
    return () => document.removeEventListener("click", handleFloatingClick);
  }, [refs.floating]);

  return (
    <>
      {isOpen && (
        <div
          ref={refs.setFloating}
          style={{
            ...floatingStyles,
          }}
          {...getFloatingProps()}
        >
          {children}
        </div>
      )}
    </>
  );
};
