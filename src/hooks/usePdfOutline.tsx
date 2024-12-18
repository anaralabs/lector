import type { PDFDocumentProxy } from "pdfjs-dist";
import { cancellable } from "../lib/cancellable";
import { usePdf } from "../internal";
import { useEffect, useState } from "react";

export const usePDFOutline = () => {
  const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);
  const [outline, setOutline] =
    useState<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>();

  useEffect(() => {
    const { promise: outline, cancel } = cancellable(
      pdfDocumentProxy.getOutline(),
    );

    outline.then(
      (result) => {
        setOutline(result);
      },
      () => {},
    );

    return () => {
      cancel();
    };
  }, []);

  return outline;
};
