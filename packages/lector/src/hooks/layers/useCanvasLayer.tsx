import { useLayoutEffect, useRef, useState, useEffect } from "react";
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
  const renderCountRef = useRef(0);
  const lastRenderedZoomRef = useRef<number | null>(null);
  const isSafariRef = useRef(isSafari());
  const pinchStartZoomRef = useRef<number | null>(null);
  const hasRenderedInitialRef = useRef(false);

  const dpr = useDpr();

  const bouncyZoom = usePdf((state) => state.zoom);
  const isPinching = usePdf((state) => state.isPinching);
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

  // Track pinch gesture start/end
  // useEffect(() => {
  //   if (isPinching && pinchStartZoomRef.current === null) {
  //     // Starting a pinch gesture
  //     pinchStartZoomRef.current = lastRenderedZoomRef.current || bouncyZoom;
  //   } else if (!isPinching && pinchStartZoomRef.current !== null) {
  //     // Ending a pinch gesture
  //     pinchStartZoomRef.current = null;
  //   }
  // }, [isPinching, bouncyZoom]);

  // Different debouncing strategy for smoother zoom
  const debounceDelay = isPinching
    ? 100  // Faster updates during pinch for responsiveness
    : 50;  // Quick settle after release

  const [debouncedZoom] = useDebounce(bouncyZoom, debounceDelay);

  // Determine which zoom value to use
  let zoom: number;
  if (!hasRenderedInitialRef.current) {
    // First render: use immediate zoom
    zoom = bouncyZoom;
  } else if (isPinching) {
    // During pinch: use debounced for stability but keep it responsive
    zoom = debouncedZoom;
  } else {
    // After pinch or normal operation: use debounced to prevent jumps
    zoom = debouncedZoom;
  }

  // Safari-specific: Force re-render on mount to ensure proper resolution
  // useEffect(() => {
  //   if (isSafariRef.current && renderCountRef.current === 0 && canvasRef.current) {
  //     // Force an initial render after a short delay
  //     const timer = setTimeout(() => {
  //       if (canvasRef.current) {
  //         // Trigger a re-render by slightly adjusting a dependency
  //         const event = new Event('safariForceRender');
  //         canvasRef.current.dispatchEvent(event);
  //       }
  //     }, 100);
  //     return () => clearTimeout(timer);
  //   }
  // }, []);

  useLayoutEffect(() => {
    if (!canvasRef.current || !pdfPageProxy) {
      return;
    }

    // Skip redundant renders with same zoom (but always render first time)
    if (hasRenderedInitialRef.current && Math.abs((lastRenderedZoomRef.current || 0) - zoom) < 0.001) {
      return;
    }

    const canvas = canvasRef.current;
    const canvasContext = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    })!;

    const baseViewport = pdfPageProxy.getViewport({ scale: 1 });

    // Get actual device pixel ratio
    const pixelRatio = window.devicePixelRatio || 1;

    // Calculate the actual dimensions we want to display
    const displayWidth = baseViewport.width * zoom;
    const displayHeight = baseViewport.height * zoom;

    // Set canvas resolution (internal buffer size)
    // This needs to be pixel-perfect for crisp rendering
    const canvasWidth = Math.floor(displayWidth * pixelRatio);
    const canvasHeight = Math.floor(displayHeight * pixelRatio);

    // Safari hack: Force a reflow if dimensions haven't changed but we need re-render
    if (isSafariRef.current && canvas.width === canvasWidth && canvas.height === canvasHeight) {
      // Force Safari to re-render by toggling canvas visibility
      canvas.style.display = 'none';
      canvas.offsetHeight; // Force reflow
      canvas.style.display = 'block';
    }

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Set CSS display size (what the user sees)
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    // Create viewport at the correct scale for rendering
    // The viewport scale should be zoom * pixelRatio to match canvas resolution
    const viewport = pdfPageProxy.getViewport({ scale: zoom * pixelRatio });

    // Reset transform to identity matrix
    canvasContext.setTransform(1, 0, 0, 1, 0, 0);

    // Safari-specific: Clear the canvas before rendering
    if (isSafariRef.current) {
      canvasContext.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Disable image smoothing for crisp text
    canvasContext.imageSmoothingEnabled = false;
    // Safari/WebKit specific vendor prefixes
    (canvasContext as any).webkitImageSmoothingEnabled = false;
    (canvasContext as any).mozImageSmoothingEnabled = false;
    (canvasContext as any).msImageSmoothingEnabled = false;

    const renderingTask = pdfPageProxy.render({
      canvasContext,
      viewport,
      background,
      intent: 'display', // Hint for PDF.js to optimize for display
    });

    renderingTask.promise
      .then(() => {
        renderCountRef.current += 1;
        lastRenderedZoomRef.current = zoom;
        hasRenderedInitialRef.current = true;

        // Safari: Force a composite layer update after successful render
        if (isSafariRef.current && renderCountRef.current <= 2) {
          requestAnimationFrame(() => {
            if (canvas) {
              canvas.style.transform = 'translateZ(0)';
              setTimeout(() => {
                if (canvas) {
                  canvas.style.transform = '';
                }
              }, 0);
            }
          });
        }
      })
      .catch((error) => {
        if (error.name === "RenderingCancelledException") {
          return;
        }
        console.error("PDF rendering error:", error);
      });

    return () => {
      void renderingTask.cancel();
    };
  }, [pdfPageProxy, zoom, background]);

  return {
    canvasRef,
  };
};
