import type { RenderTask } from "pdfjs-dist";
import { useEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../internal";
import { useDpr } from "./useDpr";
import { useVisibility } from "./useVisibility";

interface ThumbnailConfig {
  maxHeight?: number;
  maxWidth?: number;
  isFirstPage?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<ThumbnailConfig, "isFirstPage">> = {
  maxHeight: 800,
  maxWidth: 400,
};

export const useThumbnail = (
  pageNumber: number,
  config: ThumbnailConfig = {},
) => {
  const {
    maxHeight = DEFAULT_CONFIG.maxHeight,
    maxWidth = DEFAULT_CONFIG.maxWidth,
    isFirstPage = false,
  } = config;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const pageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  const { visible } = useVisibility({ elementRef: containerRef });
  const [debouncedVisible] = useDebounce(visible, 50);
  const dpr = useDpr();

  const isVisible = isFirstPage || debouncedVisible;

  useEffect(() => {
    const renderThumbnail = async () => {
      const canvas = canvasRef.current;

      if (!canvas || !pageProxy) return;

      try {
        // Cancel any existing render task
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }

        // Calculate viewport and scale
        const viewport = pageProxy.getViewport({ scale: 1 });
        const scale =
          Math.min(maxWidth / viewport.width, maxHeight / viewport.height) *
          (isVisible ? dpr : 0.5);

        const scaledViewport = pageProxy.getViewport({ scale });

        // Set canvas dimensions
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;

        // Create and store new render task
        const context = canvas.getContext("2d");
        if (!context) return;

        const renderTask = pageProxy.render({
          canvasContext: context,
          viewport: scaledViewport,
        });

        renderTaskRef.current = renderTask;
        await renderTask.promise;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.name === "RenderingCancelledException"
        ) {
          console.log("Rendering cancelled");
        } else {
          console.error("Failed to render PDF page:", error);
        }
      }
    };

    renderThumbnail();

    return () => {
      renderTaskRef.current?.cancel();
    };
  }, [pageNumber, pageProxy, isVisible, dpr, maxHeight, maxWidth]);

  return {
    canvasRef,
    containerRef,
    isVisible,
  };
};
