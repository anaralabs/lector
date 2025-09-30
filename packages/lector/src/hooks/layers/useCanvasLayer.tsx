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

    // Use PDF.js OutputScale approach (same as their official viewer)
    const pixelRatio = window.devicePixelRatio || 1;
    const outputScale = {
      sx: pixelRatio,
      sy: pixelRatio,
    };

    // Calculate canvas dimensions using outputScale
    const width = baseViewport.width * zoom;
    const height = baseViewport.height * zoom;
    
    canvas.width = Math.floor(width * outputScale.sx);
    canvas.height = Math.floor(height * outputScale.sy);
    
    // Set CSS display size (visible size)
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Get viewport at zoom scale (not DPR scale)
    const viewport = pdfPageProxy.getViewport({ scale: zoom });

    // Apply transform using outputScale (PDF.js approach)
    canvasContext.setTransform(outputScale.sx, 0, 0, outputScale.sy, 0, 0);
    
    // Disable image smoothing for crisp PDF rendering
    if (canvasContext.imageSmoothingEnabled !== undefined) {
      canvasContext.imageSmoothingEnabled = false;
    }
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
