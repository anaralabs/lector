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
      fileURL,
      loader,
      onDocumentLoad,
      isZoomFitWidth,
      zoom,
      ...props
    }: HTMLProps<HTMLDivElement> &
      usePDFDocumentParams & {
        loader?: ReactNode;
      },
    ref,
  ) => {
    const { initialState } = usePDFDocumentContext({
      fileURL,
      onDocumentLoad,
      isZoomFitWidth,
      zoom,
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
