import type { HTMLProps } from "react";
import {
  useAnnotationLayer,
  type AnnotationLayerParams,
} from "../../hooks/layers/useAnnotationLayer";
import clsx from "clsx";

export const AnnotationLayer = ({
  renderForms = true,
  className,
  style,
  ...props
}: AnnotationLayerParams & HTMLProps<HTMLDivElement>) => {
  const { annotationLayerRef } = useAnnotationLayer({
    renderForms,
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
