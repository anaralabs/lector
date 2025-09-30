import type { HTMLProps } from "react";

import { useCanvasLayer } from "../../hooks/layers/useCanvasLayer";

export const CanvasLayer = ({
  style,
  background,
  ...props
}: HTMLProps<HTMLCanvasElement> & {
  background?: string;
}) => {
  const { canvasRef } = useCanvasLayer({ background });

  return (
    <canvas
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        // Don't override width/height - let useCanvasLayer control dimensions
        ...style,
      }}
      {...props}
      ref={canvasRef}
    />
  );
};
