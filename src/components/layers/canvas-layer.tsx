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
        ...style,
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
      }}
      {...props}
      ref={canvasRef}
    />
  );
};
