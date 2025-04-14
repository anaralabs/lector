import clsx from "clsx";
import type { HTMLProps } from "react";

import {
  type AnnotationLayerParams,
  useAnnotationLayer,
} from "../../hooks/layers/useAnnotationLayer";

/**
 * AnnotationLayer renders PDF annotations like links, highlights, and form fields.
 * 
 * @param renderForms - Whether to render form fields in the annotation layer.
 * @param externalLinksEnabled - Whether external links should be clickable. When false, external links won't open.
 * @param jumpOptions - Options for page navigation behavior when clicking internal links. 
 *                      See `usePdfJump` hook for available options.
 */
export const AnnotationLayer = ({
  renderForms = true,
  externalLinksEnabled = true,
  jumpOptions = { behavior: "smooth", align: "start" },
  className,
  style,
  ...props
}: AnnotationLayerParams & HTMLProps<HTMLDivElement>) => {
  const { annotationLayerRef } = useAnnotationLayer({
    renderForms,
    externalLinksEnabled,
    jumpOptions,
  });

  return (
    <div
      className={clsx("annotationLayer", className)}
      style={{
        ...style,
        position: "absolute",
        top: 0,
        left: 0,
      }}
      {...props}
      ref={annotationLayerRef}
    />
  );
};
