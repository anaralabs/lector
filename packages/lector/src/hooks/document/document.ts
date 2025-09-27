import {
  getDocument,
  type OnProgressParameters,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import type {
  DocumentInitParameters,
  TypedArray,
} from "pdfjs-dist/types/src/display/api";
import { useEffect, useState } from "react";

import type { InitialPDFState, ZoomOptions } from "../../internal";

export interface usePDFDocumentParams {
  /**
   * The URL of the PDF file to load.
   */
  source: Source;
  onDocumentLoad?: ({
    proxy,
    source,
  }: {
    proxy: PDFDocumentProxy;
    source: Source;
  }) => void;
  initialRotation?: number;
  isZoomFitWidth?: boolean;
  zoom?: number;
  zoomOptions?: ZoomOptions;
  /**
   * An arbitrary value between 1 and 4
   * @description 1 it's the fastest render (but the lowest quality) and 4 is the slowest render (but the highest quality)
   * @important If you set it to a very high value, it will cause the PDF to render very slowly and even freeze the browser.
   * @note In some browsers and devices like Safari in Mac, setting resolution to 1 will generate blurry PDFs.
   * @default 1
  */
  resolution?: InitialPDFState["resolution"];
}

export type Source =
  | string
  | URL
  | TypedArray
  | ArrayBuffer
  | DocumentInitParameters;

export const usePDFDocumentContext = ({
  onDocumentLoad,
  source,
  initialRotation = 0,
  isZoomFitWidth,
  zoom = 1,
  zoomOptions,
  resolution = 1,
}: usePDFDocumentParams) => {
  const [_, setProgress] = useState(0);

  const [initialState, setInitialState] = useState<InitialPDFState | null>();
  const [rotation] = useState<number>(initialRotation);

  useEffect(() => {
    const generateViewports = async (pdf: PDFDocumentProxy) => {
      const pageProxies: Array<PDFPageProxy> = [];
      const rotations: number[] = [];
      const viewports = await Promise.all(
        Array.from({ length: pdf.numPages }, async (_, index) => {
          const page = await pdf.getPage(index + 1);
          // sometimes there is information about the default rotation of the document
          // stored in page.rotate. we need to always add that additional rotaton offset
          const deltaRotate = page.rotate || 0;
          const viewport = page.getViewport({
            scale: 1,
            rotation: rotation + deltaRotate,
          });
          pageProxies.push(page);
          rotations.push(page.rotate);
          return viewport;
        }),
      );

      const sortedPageProxies = pageProxies.sort((a, b) => {
        return a.pageNumber - b.pageNumber;
      });
      setInitialState((prev) => ({
        ...prev,
        isZoomFitWidth,
        viewports,
        pageProxies: sortedPageProxies,
        pdfDocumentProxy: pdf,
        zoom,
        zoomOptions,
        resolution,
      }));
    };

    const loadDocument = () => {
      setInitialState(null);
      setProgress(0);

      const loadingTask = getDocument(source);

      loadingTask.onProgress = (progressEvent: OnProgressParameters) => {
        // Added to dedupe state updates when the file is fully loaded
        if (progressEvent.loaded === progressEvent.total) {
          return;
        }

        setProgress(progressEvent.loaded / progressEvent.total);
      };

      const loadingPromise = loadingTask.promise
        .then((proxy) => {
          onDocumentLoad?.({ proxy, source });
          setProgress(1);

          generateViewports(proxy);
        })
        .catch((error) => {
          if (loadingTask.destroyed) {
            return;
          }

          console.error("Error loading PDF document", error);
        });

      return () => {
        loadingPromise.finally(() => loadingTask.destroy());
      };
    };
    loadDocument();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);


  return {
    initialState,
  };
};
