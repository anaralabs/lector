import { TextLayer } from "pdfjs-dist";
import { useEffect, useRef } from "react";

import { usePdf } from "../../internal";
import { usePDFPageNumber } from "../usePdfPageNumber";

export const useTextLayer = () => {
  const textContainerRef = useRef<HTMLDivElement>(null);

  const pageNumber = usePDFPageNumber();
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

  useEffect(() => {
    if (!textContainerRef.current) {
      return;
    }

    const textLayer = new TextLayer({
      textContentSource: pdfPageProxy.streamTextContent(),
      container: textContainerRef.current,
      viewport: pdfPageProxy.getViewport({ scale: 1 }),
    });

    void textLayer.render();

    return () => {
      textLayer.cancel();
    };
  }, [pdfPageProxy]);

  return {
    textContainerRef,
    pageNumber: pdfPageProxy.pageNumber,
  };
};
