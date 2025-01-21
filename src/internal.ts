import { Virtualizer } from "@tanstack/react-virtual";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { createRef } from "react";
import { createStore, useStore } from "zustand";

import { clamp } from "./lib/clamp";
import { getFitWidthZoom } from "./lib/zoom";
import { createZustandContext } from "./lib/zustand";

type TextContent = {
  pageNumber: number;
  text: string;
};

export type HighlightRect = {
  pageNumber: number;
  top: number;
  left: number;
  height: number;
  width: number;
  type?: "pixels" | "percent";
};

interface PDFState {
  pdfDocumentProxy: PDFDocumentProxy;

  zoom: number;
  updateZoom: (
    zoom: number | ((prevZoom: number) => number),
    isZoomFitWidth?: boolean,
  ) => void;

  isZoomFitWidth: boolean;
  zoomFitWidth: () => void;

  isPinching: boolean;
  setIsPinching: (isPinching: boolean) => void;

  currentPage: number;
  setCurrentPage: (pageNumber: number) => void;

  viewports: Array<PageViewport>;
  viewportRef: React.MutableRefObject<HTMLDivElement | null>;

  pageProxies: PDFPageProxy[];

  textContent: TextContent[];
  setTextContent: (textContents: TextContent[]) => void;

  zoomOptions: {
    minZoom: number;
    maxZoom: number;
  };

  virtualizer: PDFVirtualizer | null;
  setVirtualizer: (virtualizer: PDFVirtualizer) => void;

  highlights: HighlightRect[];
  setHighlight: (higlights: HighlightRect[]) => void;

  getPdfPageProxy: (pageNumber: number) => PDFPageProxy;

  customSelectionRects: HighlightRect[];
  setCustomSelectionRects: (rects: HighlightRect[]) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PDFVirtualizer = Virtualizer<any, any>;

export type InitialPDFState = Pick<
  PDFState,
  "pdfDocumentProxy" | "pageProxies" | "viewports" | "zoom"
> & { isZoomFitWidth?: boolean };

export const PDFStore = createZustandContext(
  (initialState: InitialPDFState) => {
    return createStore<PDFState>((set, get) => ({
      pdfDocumentProxy: initialState.pdfDocumentProxy,
      zoom: initialState.zoom,
      isZoomFitWidth: initialState.isZoomFitWidth ?? false,
      zoomOptions: {
        minZoom: 0.5,
        maxZoom: 10,
      },

      viewportRef: createRef<HTMLDivElement>(),
      viewports: initialState.viewports,

      updateZoom: (zoom, isZoomFitWidth = false) => {
        const { minZoom, maxZoom } = get().zoomOptions;

        set((state) => {
          if (typeof zoom === "function") {
            const newZoom = clamp(zoom(state.zoom), minZoom, maxZoom);
            return { zoom: newZoom, isZoomFitWidth };
          }
          const newZoom = clamp(zoom, minZoom, maxZoom);
          return { zoom: newZoom, isZoomFitWidth };
        });
      },

      zoomFitWidth: () => {
        const { viewportRef, zoomOptions, viewports } = get();

        if (!viewportRef.current) return;

        const clampedZoom = getFitWidthZoom(
          viewportRef.current.clientWidth,
          viewports,
          zoomOptions,
        );

        set({
          zoom: clampedZoom,
          isZoomFitWidth: true,
        });

        return clampedZoom;
      },

      currentPage: 1,
      setCurrentPage: (val) => {
        set({
          currentPage: val,
        });
      },

      isPinching: false,
      setIsPinching: (val) => {
        set({
          isPinching: val,
        });
      },

      virtualizer: null,
      setVirtualizer: (val) => {
        set({
          virtualizer: val,
        });
      },

      pageProxies: initialState.pageProxies,
      getPdfPageProxy: (pageNumber) => {
        const proxy = get().pageProxies[pageNumber - 1];

        if (!proxy) throw new Error(`Page ${pageNumber} does not exist`);

        return proxy;
      },

      textContent: [],
      setTextContent: (val) => {
        set({
          textContent: val,
        });
      },
      highlights: [],
      setHighlight: (val) => {
        set({
          highlights: val,
        });
      },

      customSelectionRects: [],
      setCustomSelectionRects: (val) => {
        set({
          customSelectionRects: val,
        });
      },
    }));
  },
);

export const usePdf = <T>(selector: (state: PDFState) => T) =>
  useStore(PDFStore.useContext(), selector);
