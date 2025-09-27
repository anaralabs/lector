import { Virtualizer } from "@tanstack/react-virtual";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import React, { createRef } from "react";
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
  style?: (rect: HighlightRect) => React.CSSProperties;
};

export interface ZoomOptions {
  minZoom?: number;
  maxZoom?: number;
}

export type ColoredHighlight = {
  color: string;
  rectangles: HighlightRect[];
  pageNumber: number;
  text: string;
  uuid: string;
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

  zoomOptions: Required<ZoomOptions>;

  virtualizer: PDFVirtualizer | null;
  setVirtualizer: (virtualizer: PDFVirtualizer) => void;

  highlights: HighlightRect[];
  setHighlight: (higlights: HighlightRect[]) => void;

  getPdfPageProxy: (pageNumber: number) => PDFPageProxy;

  customSelectionRects: HighlightRect[];
  setCustomSelectionRects: (rects: HighlightRect[]) => void;

  coloredHighlights: ColoredHighlight[];
  addColoredHighlight: (value: ColoredHighlight) => void;
  deleteColoredHighlight: (uuid: string) => void;

  /**
   * An arbitrary value between 1 and 4
   * @description 1 it's the fastest render (but the lowest quality) and 4 is the slowest render (but the highest quality)
   * @important If you set it to a very high value, it will cause the PDF to render very slowly and even freeze the browser.
   * @note In some browsers and devices like Safari in Mac, setting resolution to 1 will generate blurry PDFs.
   * @default 1
   */
  resolution: number;
  setResolution: (val: number) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PDFVirtualizer = Virtualizer<any, any>;

export interface InitialPDFState {
  pdfDocumentProxy: PDFDocumentProxy;
  pageProxies: PDFPageProxy[];
  viewports: Array<PageViewport>;
  zoom: number;
  isZoomFitWidth?: boolean;
  zoomOptions?: ZoomOptions;
  resolution?: PDFState["resolution"];
}

export const PDFStore = createZustandContext(
  (initialState: InitialPDFState) => {
    return createStore<PDFState>((set, get) => ({
      pdfDocumentProxy: initialState.pdfDocumentProxy,
      zoom: initialState.zoom,
      isZoomFitWidth: initialState.isZoomFitWidth ?? false,
      zoomOptions: {
        minZoom: initialState.zoomOptions?.minZoom ?? 0.5,
        maxZoom: initialState.zoomOptions?.maxZoom ?? 10,
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

      coloredHighlights: [],
      addColoredHighlight: (value: ColoredHighlight) =>
        set((prevState) => ({
          coloredHighlights: [...prevState.coloredHighlights, value],
        })),
      deleteColoredHighlight: (uuid: string) =>
        set((prevState) => ({
          coloredHighlights: prevState.coloredHighlights.filter(
            (rect) => rect.uuid !== uuid,
          ),
        })),

      resolution: Math.min(initialState.resolution ?? 1, 4),
      setResolution: (val) => {
        set({
          resolution: Math.min(Math.max(val, 1), 4),
        });
      },
    }));
  },
);

export const usePdf = <T>(selector: (state: PDFState) => T) =>
  useStore(PDFStore.useContext(), selector);
