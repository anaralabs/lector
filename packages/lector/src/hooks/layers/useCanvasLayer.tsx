import { useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

const isSafari = () => {
  if (typeof window === "undefined") return false;
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
};

export const useCanvasLayer = ({ background }: { background?: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageNumber = usePDFPageNumber();

  const dpr = useDpr();

  const bouncyZoom = usePdf((state) => state.zoom);
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

  const [zoom] = useDebounce(bouncyZoom, 100);


  useLayoutEffect(() => {
    if (!canvasRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const canvasContext = canvas.getContext("2d")!;
    const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
    const scale = dpr * zoom;

    if (isSafari()) {
      canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      canvas.width = Math.floor(baseViewport.width * scale);
      canvas.height = Math.floor(baseViewport.height * scale);
      canvas.style.width = `${baseViewport.width}px`;
      canvas.style.height = `${baseViewport.height}px`;
      
      canvasContext.imageSmoothingEnabled = false;
      (canvasContext as any).webkitImageSmoothingEnabled = false;
    } else {
      canvas.width = baseViewport.width * scale;
      canvas.height = baseViewport.height * scale;
      canvas.style.width = `${baseViewport.width}px`;
      canvas.style.height = `${baseViewport.height}px`;
      
      canvasContext.scale(scale, scale);
    }

    const viewport = isSafari() ? pdfPageProxy.getViewport({ scale }) : baseViewport;
    const renderingTask = pdfPageProxy.render({
      canvasContext,
      viewport,
      background,
    });

    renderingTask.promise.catch((error) => {
      if (error.name === "RenderingCancelledException") {
        return;
      }
      throw error;
    });

    return () => {
      void renderingTask.cancel();
    };
  }, [pdfPageProxy, dpr, zoom]);

  return {
    canvasRef,
  };
};
