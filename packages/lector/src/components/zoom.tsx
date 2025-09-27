import { type HTMLProps, useEffect, useRef, useState } from "react";

import { usePdf } from "../internal";
import { Primitive } from "./primitive";

export const ZoomIn = ({ ...props }: HTMLProps<HTMLButtonElement>) => {
  const setZoom = usePdf((state) => state.updateZoom);

  return (
    <Primitive.button
      {...props}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onClick={(e: any) => {
        props.onClick && props.onClick(e);
        setZoom((zoom) => Number((zoom + 0.1).toFixed(1)));
      }}
    />
  );
};

export const ZoomOut = ({ ...props }: HTMLProps<HTMLButtonElement>) => {
  const setZoom = usePdf((state) => state.updateZoom);

  return (
    <Primitive.button
      {...props}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onClick={(e: any) => {
        props.onClick && props.onClick(e);
        setZoom((zoom) => Number((zoom - 0.1).toFixed(1)));
      }}
    />
  );
};

export const CurrentZoom = ({ ...props }: HTMLProps<HTMLInputElement>) => {
  const setRealZoom = usePdf((state) => state.updateZoom);
  const realZoom = usePdf((state) => state.zoom);

  const [zoom, setZoom] = useState<string>((realZoom * 100).toFixed(0));
  const isSelected = useRef<boolean>(false);

  useEffect(() => {
    if (isSelected.current) {
      return;
    }

    setZoom((realZoom * 100).toFixed(0));
  }, [realZoom]);

  return (
    <input
      {...props}
      value={zoom}
      onClick={() => (isSelected.current = true)}
      onChange={(e) => {
        setRealZoom(Number(e.target.value) / 100);
        setZoom(e.target.value);
      }}
      onBlur={() => {
        isSelected.current = false;

        setZoom((realZoom * 100).toFixed(0));
      }}
    />
  );
};

export const ZoomToFit = ({
  onClick,
  ...props
}: HTMLProps<HTMLButtonElement>) => {
  const zoomFitWidth = usePdf((state) => state.zoomFitWidth);

  return (
    <Primitive.button
      {...props}
      onClick={(e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
        onClick?.(e);
        zoomFitWidth();
      }}
    />
  );
};
