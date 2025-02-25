import { forwardRef, type HTMLProps, type ReactNode } from "react";

import {
  usePDFDocumentContext,
  type usePDFDocumentParams,
} from "../hooks/document/document";
import { PDFStore } from "../internal";
import { Primitive } from "./primitive";

export const Root = forwardRef(
  (
    {
      children,
      source,
      loader,
      onDocumentLoad,
      isZoomFitWidth,
      zoom,
      zoomOptions,
      ...props
    }: HTMLProps<HTMLDivElement> &
      usePDFDocumentParams & {
        loader?: ReactNode;
      },
    ref,
  ) => {
    const { initialState } = usePDFDocumentContext({
      source,
      onDocumentLoad,
      isZoomFitWidth,
      zoom,
      zoomOptions,
    });

    return (
      <Primitive.div ref={ref} {...props}>
        {initialState ? (
          <PDFStore.Provider initialValue={initialState}>
            {children}
          </PDFStore.Provider>
        ) : (
          loader || "Loading..."
        )}
      </Primitive.div>
    );
  },
);

Root.displayName = "Root";
