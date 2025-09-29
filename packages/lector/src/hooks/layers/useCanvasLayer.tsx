import { useLayoutEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../../internal";
import { useDpr } from "../useDpr";
import { usePDFPageNumber } from "../usePdfPageNumber";

// Detect Safari browser
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

  // const { visible } = useVisibility({ elementRef: canvasRef });
  // const debouncedVisible = useDebounce(visible, 100);

  useLayoutEffect(() => {
    if (!canvasRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const canvasContext = canvas.getContext("2d")!;
    
    // Safari-specific fix for canvas rendering
    if (isSafari()) {
      // Reset any previous transformations
      canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      
      // For Safari, use a different approach to prevent blurriness
      const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
      const renderScale = dpr * zoom;
      
      // Set canvas dimensions to actual pixel size
      canvas.width = Math.floor(baseViewport.width * renderScale);
      canvas.height = Math.floor(baseViewport.height * renderScale);
      
      // Set CSS size to displayed size
      canvas.style.width = `${baseViewport.width}px`;
      canvas.style.height = `${baseViewport.height}px`;
      
      // Configure canvas context for crisp rendering
      canvasContext.imageSmoothingEnabled = false;
      // Safari-specific properties for image smoothing
      (canvasContext as any).mozImageSmoothingEnabled = false;
      (canvasContext as any).webkitImageSmoothingEnabled = false;
      (canvasContext as any).msImageSmoothingEnabled = false;
      
      // Use the scaled viewport directly for Safari
      const scaledViewport = pdfPageProxy.getViewport({ scale: renderScale });
      
      const renderingTask = pdfPageProxy.render({
        canvasContext: canvasContext,
        viewport: scaledViewport,
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
    } else {
      // Original approach for other browsers
      const viewport = pdfPageProxy.getViewport({ scale: 1 });
      const scale = dpr * zoom;

      canvas.height = viewport.height * scale;
      canvas.width = viewport.width * scale;

      canvas.style.height = `${viewport.height}px`;
      canvas.style.width = `${viewport.width}px`;

      canvasContext.scale(scale, scale);

      const renderingTask = pdfPageProxy.render({
        canvasContext: canvasContext,
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
    }
  }, [pdfPageProxy, dpr, zoom]);

  return {
    canvasRef,
  };
};
